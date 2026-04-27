import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS skills (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  display_name    TEXT,
  description     TEXT NOT NULL DEFAULT '',
  version         TEXT NOT NULL DEFAULT '1.0.0',
  category        TEXT DEFAULT NULL,
  tags            TEXT,
  attributes      TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',
  visibility      TEXT NOT NULL DEFAULT 'public',
  entry_file      TEXT DEFAULT 'SKILL.md',
  storage_path    TEXT NOT NULL,
  content_hash    TEXT,
  conditions      TEXT,
  assigned_groups TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_files (
  id              TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  file_type       TEXT NOT NULL,
  file_size       INTEGER NOT NULL,
  mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
  checksum        TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS access_logs (
  id              TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL REFERENCES skills(id),
  skill_slug      TEXT NOT NULL,
  action          TEXT NOT NULL,
  file_paths      TEXT,
  latency_ms      INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_slug ON skills(slug);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
CREATE INDEX IF NOT EXISTS idx_skills_visibility ON skills(visibility);
CREATE INDEX IF NOT EXISTS idx_skill_files_skill_id ON skill_files(skill_id);
CREATE INDEX IF NOT EXISTS idx_access_logs_created_at ON access_logs(created_at);
`;

export function runMigrations(dbPath: string): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(MIGRATION_SQL);
  db.close();
  console.log(`Database migrated: ${dbPath}`);
}

// Allow running as script
const dbPath = process.argv[2];
if (dbPath) {
  runMigrations(dbPath);
}
