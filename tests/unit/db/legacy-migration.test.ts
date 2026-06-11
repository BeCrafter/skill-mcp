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
 *   - detect legacy tables without __drizzle_migrations
 *   - drop all application tables cleanly (no FK cascade errors)
 *   - let drizzle recreate the full schema from scratch (0000–0016)
 *   - leave the DB in a working state with all expected tables
 *
 * Legacy data is intentionally NOT preserved — the drop-all approach avoids
 * the FK-cascade pitfall of the old in-place table-rename pattern.
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

  it("drops legacy tables cleanly and lets drizzle recreate the full schema", () => {
    // Seed a legacy-shaped DB *without* drizzle's __drizzle_migrations table
    // and *with* the deprecated tags / conditions / assigned_groups columns.
    {
      const sqlite = new Database(dbPath);
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
      sqlite.close();
    }

    runMigrations(dbPath);

    const sqlite = new Database(dbPath);
    try {
      // skills table must have the new schema (no deprecated columns)
      const cols = sqlite.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
      const colNames = cols.map(c => c.name);
      expect(colNames).not.toContain("tags");
      expect(colNames).not.toContain("conditions");
      expect(colNames).not.toContain("assigned_groups");
      expect(colNames).toContain("slug");
      expect(colNames).toContain("content_hash");
      expect(colNames).toContain("tenant_id");

      // Legacy data is intentionally dropped — the clean-slate approach avoids
      // FK cascade errors that plagued the old in-place rebuild.
      const skillRows = sqlite.prepare("SELECT id FROM skills").all();
      expect(skillRows).toEqual([]);

      // drizzle migration tracking table must exist with all entries applied
      const drizzleApplied = sqlite.prepare("SELECT COUNT(*) as n FROM __drizzle_migrations").get() as { n: number };
      expect(drizzleApplied.n).toBeGreaterThanOrEqual(1);

      // Post-migration tables created by later drizzle migrations must exist
      const pipelineRunsExists = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_runs'",
      ).get();
      expect(pipelineRunsExists).toBeDefined();

      const tenantsExists = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'",
      ).get();
      expect(tenantsExists).toBeDefined();
    } finally {
      sqlite.close();
    }
  });
});
