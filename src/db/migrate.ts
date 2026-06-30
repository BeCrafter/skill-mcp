import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatabaseUrl } from "./dialect.js";

/**
 * Resolve the drizzle migrations folder. We ship migration SQL alongside the
 * compiled JS (dist/db/migrate.js), but in dev/tests we run from src/. The
 * migrations themselves live at <repoRoot>/drizzle.
 */
function resolveMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up looking for a `drizzle` directory containing meta/_journal.json.
  // This handles src/db/, dist/db/, and packaged installs alike.
  for (let dir = here, i = 0; i < 6; i++, dir = dirname(dir)) {
    const candidate = join(dir, "drizzle");
    if (existsSync(join(candidate, "meta", "_journal.json"))) return candidate;
  }
  // Fallback: assume cwd-relative.
  return resolve(process.cwd(), "drizzle");
}


/**
 * One-time legacy upgrade for databases that were created by the previous
 * raw-SQL migrate.ts (no __drizzle_migrations table). Drops all tables that
 * the drizzle baseline (0000) will recreate, then lets drizzle's migrator
 * build the full schema from scratch.
 *
 * This approach avoids the FK-cascade pitfall of the old table-rename pattern:
 * when `skills` is rebuilt in-place, any table with a FOREIGN KEY referencing
 * `skills(id)` gets its rows cascade-deleted even with `PRAGMA foreign_keys=OFF`
 * because the `REFERENCES` clause in CREATE TABLE is still enforced by SQLite
 * during the same multi-statement `db.exec()` call.
 *
 * Returns true if a legacy upgrade was performed.
 */
function legacyUpgradeIfNeeded(db: Database.Database, _migrationsFolder: string): boolean {
  // If drizzle's migration table exists AND has entries AND all baseline tables
  // are present, this DB is properly migrated. Skip.
  const hasDrizzleTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
    .get();
  if (hasDrizzleTable) {
    const cnt = db.prepare("SELECT COUNT(*) as n FROM __drizzle_migrations").get() as { n: number };
    if (cnt.n > 0) {
      // Sanity check: all 9 tables from baseline 0000 must exist. A partial
      // migration (e.g. only skills + users) leaves the DB broken for later
      // migrations that ALTER missing tables (0009 adds tenant_id to skill_files).
      const baselineTables = [
        "skills", "skill_tags", "skill_files", "skill_versions",
        "access_logs", "skill_feedbacks", "users", "user_roles", "roles",
      ];
      const missing = baselineTables.filter((t) =>
        !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t),
      );
      if (missing.length === 0) return false;
      // Tables are missing — fall through to full cleanup below.
    }
  }

  // If no application tables exist, this is a fresh DB — drizzle will run
  // the baseline migration normally.
  const anyTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  if (!anyTable) return false;

  // Legacy or broken DB detected. Drop all application tables in reverse-
  // dependency order so drizzle can recreate them cleanly (0000–0016).
  //
  // Also drops __drizzle_migrations so drizzle starts from scratch rather
  // than skipping already-"applied" entries that correspond to missing tables.
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS skill_eval_runs;
    DROP TABLE IF EXISTS skill_eval_cases;
    DROP TABLE IF EXISTS skill_embeddings;
    DROP TABLE IF EXISTS oidc_group_role_map;
    DROP TABLE IF EXISTS oidc_identities;
    DROP TABLE IF EXISTS webhook_deliveries;
    DROP TABLE IF EXISTS webhooks;
    DROP TABLE IF EXISTS tenant_quota_overrides;
    DROP TABLE IF EXISTS tenant_quotas;
    DROP TABLE IF EXISTS usage_events;
    DROP TABLE IF EXISTS cache_user_epochs;
    DROP TABLE IF EXISTS cache_global_epoch;
    DROP TABLE IF EXISTS pipeline_runs;
    DROP TABLE IF EXISTS import_jobs;
    DROP TABLE IF EXISTS skill_versions;
    DROP TABLE IF EXISTS skill_feedbacks;
    DROP TABLE IF EXISTS skill_tags;
    DROP TABLE IF EXISTS skill_files;
    DROP TABLE IF EXISTS access_logs;
    DROP TABLE IF EXISTS user_roles;
    DROP TABLE IF EXISTS roles;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS skills;
    DROP TABLE IF EXISTS tenants;
    DROP TABLE IF EXISTS __drizzle_migrations;
    PRAGMA foreign_keys = ON;
  `);

  return true;
}



export function runMigrations(dbInput: string): void {
  // P0-8 — accept both legacy bare paths and URL-form (sqlite://, postgres://).
  // Postgres migrations are P1; reject loudly so the caller fails fast.
  const cfg = parseDatabaseUrl(dbInput);
  if (cfg.dialect !== "sqlite" || !cfg.path) {
    throw new Error(`runMigrations: only sqlite is supported in P0-8 (got dialect=${cfg.dialect}). PG migrations tracked as P1.`);
  }
  const dbPath = cfg.path;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const migrationsFolder = resolveMigrationsFolder();

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  legacyUpgradeIfNeeded(sqlite, migrationsFolder);

  // Pre-migration cleanup: if skills data contains duplicate (name, content_hash)
  // pairs, migration 0002's UNIQUE INDEX will fail. Deduplicate by keeping only
  // the most recently updated row per (name, content_hash). Guard with a
  // table-existence check — legacyUpgradeIfNeeded may have dropped everything.
  // FK enforcement is disabled during the DELETE to avoid cascade/NO ACTION
  // failures on dependent tables like access_logs.
  const hasSkills = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skills'")
    .get();
  if (hasSkills) {
    sqlite.pragma("foreign_keys = OFF");
    sqlite.exec(`
      DELETE FROM skills
      WHERE content_hash IS NOT NULL
        AND rowid NOT IN (
          SELECT MAX(rowid) FROM skills
          WHERE content_hash IS NOT NULL
          GROUP BY name, content_hash
        );
    `);
    sqlite.pragma("foreign_keys = ON");
  }

  // Disable FK enforcement for the entire drizzle migration run. Several
  // later migrations (0001, 0009, etc.) rebuild tables via INSERT-SELECT into
  // a new table that has REFERENCES clauses; if orphaned rows exist (from our
  // dedup cleanup above or from a partial prior migration), those INSERTs fail
  // with SQLITE_CONSTRAINT_FOREIGNKEY. Drizzle's own per-migration
  // PRAGMA foreign_keys=OFF is insufficient when exec() splits statements on
  // semicolons — setting it at the session level guarantees it stays off.
  sqlite.pragma("foreign_keys = OFF");
  const db = drizzle(sqlite);

  // ponytail: idempotency guard for migration 0018. If the 'username' column
  // already exists (e.g. from a prior 0017 run) but the journal tag is
  // '0018_user_type_and_login', drizzle will re-run the ALTER TABLE and crash
  // with "duplicate column name". Pre-check and mark as applied to avoid this.
  const MIGRATION_0018_TAG = "0018_user_type_and_login";
  try {
    const hasUsernameCol = sqlite.prepare(
      "SELECT name FROM pragma_table_info('users') WHERE name = 'username'"
    ).get();
    if (hasUsernameCol) {
      const hasTag = sqlite.prepare(
        "SELECT 1 FROM __drizzle_migrations WHERE hash = ?"
      ).get(MIGRATION_0018_TAG);
      if (!hasTag) {
        sqlite.prepare(
          "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)"
        ).run(MIGRATION_0018_TAG, Date.now());
      }
    }
  } catch {
    // Table may not exist yet on fresh DB — let migrate() handle it
  }

  // Idempotency guard for migration 0020: if token_plaintext column doesn't
  // exist but the migration tag is recorded, reset it so drizzle re-runs it.
  const MIGRATION_0020_TAG = "0020_skill_versions_is_current";
  try {
    const hasTokenPlaintext = sqlite.prepare(
      "SELECT name FROM pragma_table_info('users') WHERE name = 'token_plaintext'"
    ).get();
    if (!hasTokenPlaintext) {
      const hasTag = sqlite.prepare(
        "SELECT 1 FROM __drizzle_migrations WHERE hash = ?"
      ).get(MIGRATION_0020_TAG);
      if (hasTag) {
        sqlite.prepare(
          "DELETE FROM __drizzle_migrations WHERE hash = ?"
        ).run(MIGRATION_0020_TAG);
      }
    }
  } catch {
    // Table may not exist yet — let migrate() handle it
  }

  migrate(db, { migrationsFolder });
  sqlite.pragma("foreign_keys = ON");

  sqlite.close();
}

// Allow running as script: node migrate.js <dbPath>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbPath = process.argv[2];
  if (dbPath) runMigrations(dbPath);
}
