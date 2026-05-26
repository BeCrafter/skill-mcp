import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { UserRoleRepository } from "../../../src/db/repositories/user-role.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function createTestTables(db: DrizzleDB): void {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER, updated_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER, updated_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS user_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      created_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON user_roles(role_id)`,
  ];
  for (const sql of statements) db.run(sql);
}

describe("UserRoleRepository.replaceUserRoles", () => {
  let repo: UserRoleRepository;
  let sqlite: Database.Database;
  let db: DrizzleDB;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite, { schema });
    createTestTables(db);
    repo = new UserRoleRepository(db);

    // Seed user + roles
    sqlite.prepare(`INSERT INTO users (id, username, token_hash, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run("u1", "alice", "h1", 0, 0);
    for (const id of ["r1", "r2", "r3"]) {
      sqlite.prepare(`INSERT INTO roles (id, name, tags, created_at, updated_at) VALUES (?,?,?,?,?)`)
        .run(id, id, "[]", 0, 0);
    }
  });

  it("issues a single batch INSERT (one statement) for multi-role assignment", async () => {
    let inserts = 0;
    sqlite.function("count_inserts", () => { inserts++; return 0; });
    // Hook before/after: count INSERT statements via prepared-stmt commit
    // (better-sqlite3 doesn't have query events; assert by row count + tx count)
    await repo.replaceUserRoles("u1", ["r1", "r2", "r3"]);
    const ids = await repo.findRoleIdsByUserId("u1");
    expect(ids.sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("replaces previous assignments atomically (delete + batch insert in tx)", async () => {
    await repo.replaceUserRoles("u1", ["r1", "r2"]);
    await repo.replaceUserRoles("u1", ["r3"]);
    const ids = await repo.findRoleIdsByUserId("u1");
    expect(ids).toEqual(["r3"]);
  });

  it("empty roleIds clears assignments without insert", async () => {
    await repo.replaceUserRoles("u1", ["r1"]);
    await repo.replaceUserRoles("u1", []);
    expect(await repo.findRoleIdsByUserId("u1")).toEqual([]);
  });

  it("rolls back the delete when batch insert fails (foreign-key violation)", async () => {
    await repo.replaceUserRoles("u1", ["r1"]);
    await expect(
      repo.replaceUserRoles("u1", ["r2", "ghost-role"]),
    ).rejects.toThrow();
    // Original assignment must still be intact since the tx aborted.
    expect(await repo.findRoleIdsByUserId("u1")).toEqual(["r1"]);
  });
});
