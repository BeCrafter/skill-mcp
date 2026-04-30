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
  user_id         TEXT,
  session_id      TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  token           TEXT NOT NULL UNIQUE,
  status          TEXT DEFAULT 'active',
  created_at      INTEGER,
  updated_at      INTEGER
);

CREATE TABLE IF NOT EXISTS roles (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  description     TEXT,
  tags            TEXT NOT NULL,
  created_at      INTEGER,
  updated_at      INTEGER
);

CREATE TABLE IF NOT EXISTS user_roles (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id         TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at      INTEGER
);

CREATE TABLE IF NOT EXISTS skill_feedbacks (
  id              TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  skill_slug      TEXT NOT NULL,
  user_id         TEXT,
  session_id      TEXT,
  outcome         TEXT NOT NULL,
  context         TEXT,
  agent_comment   TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id              TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  storage_path    TEXT NOT NULL,
  entry_file      TEXT DEFAULT 'SKILL.md',
  file_count      INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT,
  change_summary  TEXT,
  created_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_slug ON skills(slug);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
CREATE INDEX IF NOT EXISTS idx_skills_visibility ON skills(visibility);
CREATE INDEX IF NOT EXISTS idx_skill_files_skill_id ON skill_files(skill_id);
CREATE INDEX IF NOT EXISTS idx_access_logs_created_at ON access_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_feedbacks_skill_slug ON skill_feedbacks(skill_slug);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created_at ON skill_feedbacks(created_at);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_id ON skill_versions(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_versions_version ON skill_versions(skill_id, version);
CREATE INDEX IF NOT EXISTS idx_skill_versions_created_at ON skill_versions(created_at);
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
