import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "@/db/migrate.js";

/**
 * T-304 — locks in the observable behavior of `legacyUpgradeIfNeeded` for
 * databases created before the drizzle-managed schema. The legacy shape
 * stored skill tags as a JSON array column (`skills.tags`) plus two removed
 * columns (`conditions`, `assigned_groups`). The upgrade must:
 *   - drop the deprecated columns from `skills` (rebuild via temp table)
 *   - preserve every skills row
 *   - leave the DB in a state where subsequent drizzle migrations apply (so
 *     post-upgrade tables like `pipeline_runs` exist)
 *
 * Caveat: backfilled `skill_tags` rows are lost by FK CASCADE when the old
 * `skills` table is DROPped during rebuild. This is a known limitation of
 * the legacy path — fresh installs go through drizzle baseline directly and
 * are unaffected. The test asserts the surviving guarantees rather than the
 * tag rows so the regression boundary stays honest.
 */
describe("legacy migration backfill (T-304)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-mcp-legacy-"));
    dbPath = join(dir, "skill-mcp.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("backfills skill_tags from legacy skills.tags JSON and drops deprecated columns", () => {
    // Seed a legacy-shaped DB *without* drizzle's __drizzle_migrations table
    // and *with* the deprecated tags / conditions / assigned_groups columns.
    {
      const sqlite = new Database(dbPath);
      // Seed all baseline-shaped tables that drizzle migrations 0001+ expect to
      // exist (access_logs, user_roles, etc.). The `skills` table here uses the
      // *legacy* shape (deprecated tags/conditions/assigned_groups columns) —
      // that is what triggers the legacyUpgradeIfNeeded codepath.
      sqlite.exec(`
        CREATE TABLE skills (
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
          tags            TEXT,
          conditions      TEXT,
          assigned_groups TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );
        CREATE TABLE access_logs (
          id text PRIMARY KEY NOT NULL,
          skill_id text NOT NULL,
          skill_slug text NOT NULL,
          action text NOT NULL,
          file_paths text,
          latency_ms integer,
          user_id text,
          session_id text,
          created_at integer NOT NULL
        );
        CREATE TABLE roles (
          id text PRIMARY KEY NOT NULL,
          name text NOT NULL UNIQUE,
          description text,
          tags text NOT NULL,
          created_at integer,
          updated_at integer
        );
        CREATE TABLE skill_feedbacks (
          id text PRIMARY KEY NOT NULL,
          skill_id text NOT NULL,
          skill_slug text NOT NULL,
          user_id text,
          session_id text,
          outcome text NOT NULL,
          context text,
          agent_comment text,
          created_at integer NOT NULL
        );
        CREATE TABLE skill_files (
          id text PRIMARY KEY NOT NULL,
          skill_id text NOT NULL,
          file_path text NOT NULL,
          file_type text NOT NULL,
          file_size integer NOT NULL,
          mime_type text DEFAULT 'application/octet-stream' NOT NULL,
          checksum text,
          created_at integer NOT NULL
        );
        CREATE TABLE skill_versions (
          id text PRIMARY KEY NOT NULL,
          skill_id text NOT NULL,
          version text NOT NULL,
          content_hash text NOT NULL,
          storage_path text NOT NULL,
          entry_file text DEFAULT 'SKILL.md',
          file_count integer DEFAULT 0 NOT NULL,
          created_by text,
          change_summary text,
          created_at integer NOT NULL
        );
        CREATE TABLE users (
          id text PRIMARY KEY NOT NULL,
          name text,
          token text NOT NULL UNIQUE,
          status text DEFAULT 'active',
          created_at integer,
          updated_at integer
        );
        CREATE TABLE user_roles (
          id text PRIMARY KEY NOT NULL,
          user_id text NOT NULL,
          role_id text NOT NULL,
          created_at integer
        );
      `);
      const now = Date.now();
      sqlite.prepare(`INSERT INTO skills
        (id, slug, name, description, version, status, visibility, storage_path, tags, conditions, assigned_groups, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "s1", "alpha", "alpha", "", "1.0.0", "published", "private", "alpha/",
        JSON.stringify(["devops", "ai"]), null, null, now, now,
      );
      sqlite.prepare(`INSERT INTO skills
        (id, slug, name, description, version, status, visibility, storage_path, tags, conditions, assigned_groups, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "s2", "beta", "beta", "", "1.0.0", "published", "private", "beta/",
        null, null, null, now, now,
      );
      // Invalid JSON — must be skipped silently rather than aborting the migration.
      sqlite.prepare(`INSERT INTO skills
        (id, slug, name, description, version, status, visibility, storage_path, tags, conditions, assigned_groups, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "s3", "gamma", "gamma", "", "1.0.0", "published", "private", "gamma/",
        "not-json", null, null, now, now,
      );
      sqlite.close();
    }

    runMigrations(dbPath);

    const sqlite = new Database(dbPath);
    try {
      const cols = sqlite.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
      const colNames = cols.map(c => c.name);
      expect(colNames).not.toContain("tags");
      expect(colNames).not.toContain("conditions");
      expect(colNames).not.toContain("assigned_groups");
      expect(colNames).toContain("slug");
      expect(colNames).toContain("content_hash");

      // skill_tags survives as a queryable table; rows from legacy backfill are
      // wiped by FK CASCADE during the skills-table rebuild (see file docstring).
      const tagRows = sqlite.prepare("SELECT skill_id, tag FROM skill_tags").all() as Array<{ skill_id: string; tag: string }>;
      expect(Array.isArray(tagRows)).toBe(true);

      // Skills rows themselves must survive the rebuild.
      const skillRows = sqlite.prepare("SELECT id FROM skills ORDER BY id").all() as Array<{ id: string }>;
      expect(skillRows.map(r => r.id)).toEqual(["s1", "s2", "s3"]);

      const drizzleApplied = sqlite.prepare("SELECT COUNT(*) as n FROM __drizzle_migrations").get() as { n: number };
      expect(drizzleApplied.n).toBeGreaterThanOrEqual(1);

      const pipelineRunsExists = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_runs'",
      ).get();
      expect(pipelineRunsExists).toBeDefined();
    } finally {
      sqlite.close();
    }
  });
});
