import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { getDatabase, closeDatabase } from "@/db/connection.js";

describe("getDatabase dialect routing (P0-8)", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    closeDatabase();
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  it("opens a sqlite database from a bare path", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillmcp-conn-"));
    tmpDirs.push(dir);
    const db = getDatabase(join(dir, "test.db"));
    expect(db).toBeTruthy();
  });

  it("opens a sqlite database from a sqlite:// URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillmcp-conn-"));
    tmpDirs.push(dir);
    const db = getDatabase(`sqlite://${join(dir, "test.db")}`);
    expect(db).toBeTruthy();
  });

  it("throws a clear error for postgres until P1 schema port lands", () => {
    expect(() => getDatabase("postgres://user@host/db"))
      .toThrow(/Postgres dialect detected/);
  });

  it("throws on unsupported schemes", () => {
    expect(() => getDatabase("mysql://host/db")).toThrow(/Unsupported database scheme/);
  });
});
