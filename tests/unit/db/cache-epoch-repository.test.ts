import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema.js";
import { CacheEpochRepository } from "@/db/repositories/cache-epoch.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; repo: CacheEpochRepository } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE cache_global_epoch (
    id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE cache_user_epochs (
    user_id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`);
  return { db, repo: new CacheEpochRepository(db) };
}

describe("CacheEpochRepository (P0-B)", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("loadGlobal returns 0 when never persisted", () => {
    expect(ctx.repo.loadGlobal()).toBe(0);
  });

  it("saveGlobal then loadGlobal round-trips", () => {
    ctx.repo.saveGlobal(7);
    expect(ctx.repo.loadGlobal()).toBe(7);
  });

  it("saveGlobal upserts (subsequent saves overwrite)", () => {
    ctx.repo.saveGlobal(1);
    ctx.repo.saveGlobal(2);
    ctx.repo.saveGlobal(3);
    expect(ctx.repo.loadGlobal()).toBe(3);
  });

  it("loadAllUsers returns empty map when nothing persisted", () => {
    const map = ctx.repo.loadAllUsers();
    expect(map.size).toBe(0);
  });

  it("saveUser then loadAllUsers round-trips", () => {
    ctx.repo.saveUser("alice", 4);
    ctx.repo.saveUser("bob", 9);
    const map = ctx.repo.loadAllUsers();
    expect(map.get("alice")).toBe(4);
    expect(map.get("bob")).toBe(9);
    expect(map.size).toBe(2);
  });

  it("saveUser upserts existing user", () => {
    ctx.repo.saveUser("alice", 1);
    ctx.repo.saveUser("alice", 2);
    ctx.repo.saveUser("alice", 5);
    expect(ctx.repo.loadAllUsers().get("alice")).toBe(5);
  });

  it("saveUsers writes multiple updates atomically (per-row UPSERT)", () => {
    ctx.repo.saveUsers([["alice", 1], ["bob", 2], ["carol", 3]]);
    const map = ctx.repo.loadAllUsers();
    expect(map.get("alice")).toBe(1);
    expect(map.get("bob")).toBe(2);
    expect(map.get("carol")).toBe(3);
  });

  it("saveUsers with empty iterable is a no-op", () => {
    expect(() => ctx.repo.saveUsers([])).not.toThrow();
    expect(ctx.repo.loadAllUsers().size).toBe(0);
  });

  it("saveUsers upserts existing users without affecting unrelated rows", () => {
    ctx.repo.saveUser("alice", 5);
    ctx.repo.saveUser("bob", 5);
    ctx.repo.saveUsers([["alice", 10]]);
    const map = ctx.repo.loadAllUsers();
    expect(map.get("alice")).toBe(10);
    expect(map.get("bob")).toBe(5);
  });
});
