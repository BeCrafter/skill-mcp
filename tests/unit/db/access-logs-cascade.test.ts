import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrate.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("access_logs ON DELETE CASCADE (T-003)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-mcp-cascade-"));
    dbPath = join(dir, "skill-mcp.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("deleting a skill cascades to its access_logs rows", () => {
    runMigrations(dbPath);

    const sqlite = new Database(dbPath);
    sqlite.pragma("foreign_keys = ON");

    sqlite.prepare(
      `INSERT INTO skills (id, slug, name, description, version, status, visibility, storage_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "skill-1", "demo", "demo", "", "1.0.0", "published", "private", "demo/", Date.now(), Date.now(),
    );

    sqlite.prepare(
      `INSERT INTO access_logs (id, skill_id, skill_slug, action, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("log-1", "skill-1", "demo", "view", Date.now());

    expect(
      (sqlite.prepare(`SELECT COUNT(*) as c FROM access_logs`).get() as { c: number }).c,
    ).toBe(1);

    sqlite.prepare(`DELETE FROM skills WHERE id = ?`).run("skill-1");

    expect(
      (sqlite.prepare(`SELECT COUNT(*) as c FROM access_logs`).get() as { c: number }).c,
    ).toBe(0);

    sqlite.close();
  });

  it("baseline has no leftover redundant idx_skills_slug index (T-406)", () => {
    runMigrations(dbPath);
    const sqlite = new Database(dbPath);
    const rows = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='skills'`)
      .all() as Array<{ name: string }>;
    const names = rows.map(r => r.name);
    // The UNIQUE index produced by the slug UNIQUE constraint must remain.
    expect(names).toContain("skills_slug_unique");
    // The redundant non-unique idx_skills_slug must be gone after 0001.
    expect(names).not.toContain("idx_skills_slug");
    sqlite.close();
  });
});
