import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase, createDatabase, closeDatabase } from "@/db/connection.js";

describe("db/connection", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    closeDatabase();
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
    }
    tmpDirs.length = 0;
  });

  function freshPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "skill-mcp-conn-"));
    tmpDirs.push(dir);
    return join(dir, "nested", "db.sqlite");
  }

  it("getDatabase auto-creates parent directories", () => {
    const path = freshPath();
    expect(existsSync(path)).toBe(false);
    const db = getDatabase(path);
    expect(db).toBeDefined();
    expect(existsSync(path)).toBe(true);
  });

  it("getDatabase returns the same instance for the same path (singleton)", () => {
    const path = freshPath();
    const a = getDatabase(path);
    const b = getDatabase(path);
    expect(a).toBe(b);
  });

  it("getDatabase reopens a fresh connection when the path changes", () => {
    const a = getDatabase(freshPath());
    const b = getDatabase(freshPath());
    expect(a).not.toBe(b);
  });

  it("createDatabase always closes and reopens, returning a new handle", () => {
    const path = freshPath();
    const a = createDatabase(path);
    const b = createDatabase(path);
    expect(a).not.toBe(b);
  });

  it("closeDatabase is idempotent", () => {
    closeDatabase();
    expect(() => closeDatabase()).not.toThrow();
  });

  it("WAL + foreign_keys pragmas are enabled", () => {
    const path = freshPath();
    const db = getDatabase(path);
    // drizzle exposes raw .all(); use $client for direct sqlite access.
    const sqlite = (db as unknown as { $client: { pragma: (q: string) => unknown } }).$client;
    expect(JSON.stringify(sqlite.pragma("journal_mode")).toLowerCase()).toContain("wal");
    expect(JSON.stringify(sqlite.pragma("foreign_keys"))).toContain("1");
  });
});
