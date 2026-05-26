import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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

interface MigrationJournal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}

/**
 * One-time legacy upgrade for databases that were created by the previous
 * raw-SQL migrate.ts (no __drizzle_migrations table). Detects the old
 * `skills` schema (with `tags`, `conditions`, `assigned_groups` columns)
 * and converts it to the new shape, backfilling `skill_tags` from JSON.
 *
 * After this runs, we synthesize the __drizzle_migrations table and mark
 * the baseline migration as already applied so drizzle's migrator skips it.
 *
 * Returns true if a legacy upgrade was performed.
 */
function legacyUpgradeIfNeeded(db: Database.Database, migrationsFolder: string): boolean {
  // If drizzle's migration table already exists, this DB has been migrated
  // before (or is being initialized via drizzle on a fresh DB). Skip.
  const drizzleTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
    .get();
  if (drizzleTable) return false;

  // If the skills table doesn't exist, this is a fresh DB — drizzle will
  // run the baseline migration normally.
  const skillsTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skills'")
    .get();
  if (!skillsTable) return false;

  // Inspect columns on the existing skills table.
  const cols = db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
  const hasTags = cols.some((c) => c.name === "tags");
  const hasConditions = cols.some((c) => c.name === "conditions");
  const hasAssignedGroups = cols.some((c) => c.name === "assigned_groups");

  // Already on the new schema — nothing to backfill, but we still need to
  // stamp __drizzle_migrations so future migrations work.
  if (!hasTags && !hasConditions && !hasAssignedGroups) {
    stampBaselineApplied(db, migrationsFolder);
    return true;
  }

  const tx = db.transaction(() => {
    // 1. Ensure skill_tags exists.
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_tags (
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        tag      TEXT NOT NULL,
        PRIMARY KEY (skill_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_skill_tags_tag ON skill_tags (tag);
    `);

    // 2. Backfill skill_tags from skills.tags (JSON array). json_each
    //    silently skips NULL/invalid JSON, so this is safe even for rows
    //    written before the column was populated consistently.
    if (hasTags) {
      db.exec(`
        INSERT OR IGNORE INTO skill_tags (skill_id, tag)
        SELECT s.id, je.value
        FROM skills s, json_each(s.tags) je
        WHERE s.tags IS NOT NULL
          AND json_valid(s.tags)
          AND json_type(s.tags) = 'array'
          AND je.value IS NOT NULL
          AND je.value <> '';
      `);
    }

    // 3. Recreate skills without deprecated columns. SQLite cannot DROP
    //    multiple columns idiomatically across older versions, so we use
    //    the table-rename pattern and copy known-good columns explicitly.
    db.exec(`
      CREATE TABLE skills__new (
        id              TEXT PRIMARY KEY,
        slug            TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        display_name    TEXT,
        description     TEXT NOT NULL DEFAULT '',
        version         TEXT NOT NULL DEFAULT '0.0.1',
        category        TEXT,
        attributes      TEXT,
        status          TEXT NOT NULL DEFAULT 'draft',
        visibility      TEXT NOT NULL DEFAULT 'private',
        entry_file      TEXT DEFAULT 'SKILL.md',
        storage_path    TEXT NOT NULL,
        content_hash    TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      INSERT INTO skills__new (
        id, slug, name, display_name, description, version, category,
        attributes, status, visibility, entry_file, storage_path,
        content_hash, created_at, updated_at
      )
      SELECT
        id, slug, name, display_name, description, version, category,
        attributes, status, visibility, entry_file, storage_path,
        content_hash, created_at, updated_at
      FROM skills;

      DROP TABLE skills;
      ALTER TABLE skills__new RENAME TO skills;

      -- Index names must match the drizzle baseline (0000_baseline.sql) so
      -- that subsequent migrations can DROP/ALTER them by their canonical
      -- names. The UNIQUE constraint on slug above already provides slug
      -- uniqueness via SQLite's sqlite_autoindex; we additionally name the
      -- unique index 'skills_slug_unique' to match drizzle's convention.
      CREATE UNIQUE INDEX IF NOT EXISTS skills_slug_unique ON skills(slug);
      CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
      CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
      CREATE INDEX IF NOT EXISTS idx_skills_visibility ON skills(visibility);
    `);

    // 4. Stamp baseline as applied so drizzle's migrator does not try to
    //    recreate tables that already exist.
    stampBaselineApplied(db, migrationsFolder);
  });

  tx();
  return true;
}

function stampBaselineApplied(db: Database.Database, migrationsFolder: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
  `);
  // We only stamp the very first (baseline) migration as already applied —
  // the legacy upgrade above only brings the schema up to baseline shape.
  // Any later migrations (FK fixes, index drops, etc.) MUST be executed by
  // the drizzle migrator. Stamping them here would silently skip them.
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as MigrationJournal;
  const baseline = journal.entries.find((e) => e.idx === 0);
  if (!baseline) return;
  const sqlPath = join(migrationsFolder, `${baseline.tag}.sql`);
  if (!existsSync(sqlPath)) return;
  const sql = readFileSync(sqlPath, "utf-8");
  const hash = sha256Hex(sql);
  // Use the journal's `when` timestamp (NOT Date.now()). Drizzle's migrator
  // skips any journal entry whose `when` is <= MAX(created_at) in this table,
  // so a Date.now() stamp would silently skip every later migration.
  db.prepare(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  ).run(hash, baseline.when);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function runMigrations(dbPath: string): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const migrationsFolder = resolveMigrationsFolder();

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  legacyUpgradeIfNeeded(sqlite, migrationsFolder);

  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder });

  sqlite.close();
}

// Allow running as script: node migrate.js <dbPath>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbPath = process.argv[2];
  if (dbPath) runMigrations(dbPath);
}
