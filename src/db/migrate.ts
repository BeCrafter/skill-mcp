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
 * Drop all application tables so drizzle can recreate from the single baseline.
 * Only drops when the DB is legacy (no __drizzle_migrations) or empty.
 * Skips when __drizzle_migrations already has entries (already migrated).
 */
function resetAndRecreate(db: Database.Database): void {
  const hasDrizzleTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
    .get();
  if (hasDrizzleTable) {
    const cnt = db.prepare("SELECT COUNT(*) as n FROM __drizzle_migrations").get() as { n: number };
    if (cnt.n > 0) return; // already migrated
  }
  const anyTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  if (!anyTable) return; // fresh DB
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS skill_eval_runs;
    DROP TABLE IF EXISTS skill_eval_cases;
    DROP TABLE IF EXISTS skill_embeddings;
    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS oidc_group_role_map;
    DROP TABLE IF EXISTS oidc_identities;
    DROP TABLE IF EXISTS webhook_deliveries;
    DROP TABLE IF EXISTS webhooks;
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
    DROP TABLE IF EXISTS __drizzle_migrations;
    PRAGMA foreign_keys = ON;
  `);
}

export function runMigrations(dbInput: string): void {
  const cfg = parseDatabaseUrl(dbInput);
  if (cfg.dialect !== "sqlite" || !cfg.path) {
    throw new Error(`runMigrations: only sqlite is supported (got dialect=${cfg.dialect}).`);
  }
  const dbPath = cfg.path;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const migrationsFolder = resolveMigrationsFolder();
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");

  resetAndRecreate(sqlite);

  sqlite.pragma("foreign_keys = OFF");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder });
  sqlite.pragma("foreign_keys = ON");
  sqlite.close();
}
