import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/db/migrate.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("user_roles UNIQUE(user_id, role_id) (T-602)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-mcp-uk-"));
    dbPath = join(dir, "skill-mcp.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects duplicate (user_id, role_id) at the DB layer", () => {
    runMigrations(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("foreign_keys = ON");

    sqlite.prepare(
      `INSERT INTO users (id, name, token, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("u1", "alice", "tok-1", "active", Date.now(), Date.now());

    sqlite.prepare(
      `INSERT INTO roles (id, name, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("r1", "team-red", "[]", Date.now(), Date.now());

    sqlite.prepare(
      `INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)`,
    ).run("ur1", "u1", "r1", Date.now());

    expect(() =>
      sqlite.prepare(
        `INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)`,
      ).run("ur2", "u1", "r1", Date.now()),
    ).toThrow(/UNIQUE/);

    sqlite.close();
  });

  it("uk_user_roles_user_role index exists; old idx_user_roles_user_id is gone", () => {
    runMigrations(dbPath);
    const sqlite = new Database(dbPath);
    const idx = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='user_roles'`)
      .all() as Array<{ name: string }>;
    const names = idx.map((r) => r.name);
    expect(names).toContain("uk_user_roles_user_role");
    expect(names).not.toContain("idx_user_roles_user_id");
    sqlite.close();
  });
});
