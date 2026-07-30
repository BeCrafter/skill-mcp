import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "@/db/migrate.js";

describe("legacy migration safety", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-mcp-legacy-"));
    dbPath = join(dir, "skill-mcp.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fails closed for an untracked legacy database without modifying existing data", () => {
    const sqlite = new Database(dbPath);
    sqlite.exec("CREATE TABLE skills (id TEXT PRIMARY KEY, slug TEXT NOT NULL)");
    sqlite.prepare("INSERT INTO skills (id, slug) VALUES (?, ?)").run("legacy-skill", "preserved");
    sqlite.close();

    expect(() => runMigrations(dbPath)).toThrow(/Refusing to migrate untracked legacy database/);

    const verified = new Database(dbPath, { readonly: true });
    try {
      expect(verified.prepare("SELECT id, slug FROM skills").all()).toEqual([{ id: "legacy-skill", slug: "preserved" }]);
      expect(verified.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'").get()).toBeUndefined();
    } finally {
      verified.close();
    }
  });
});
