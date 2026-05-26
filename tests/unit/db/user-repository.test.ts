import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { UserRepository } from "../../../src/db/repositories/user.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; repo: UserRepository } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE users (
    id TEXT PRIMARY KEY, name TEXT, token TEXT NOT NULL UNIQUE,
    status TEXT DEFAULT 'active', created_at INTEGER, updated_at INTEGER
  )`);
  return { db, repo: new UserRepository(db) };
}

describe("UserRepository", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("create persists name + token, defaults status to 'active', stamps timestamps", async () => {
    const u = await ctx.repo.create({ name: "alice", token: "hash-1" });
    expect(u.name).toBe("alice");
    expect(u.token).toBe("hash-1");
    expect(u.status).toBe("active");
    expect(typeof u.createdAt).toBe("number");
    expect(u.createdAt).toBe(u.updatedAt);
  });

  it("create allows null name", async () => {
    const u = await ctx.repo.create({ token: "hash-x" });
    expect(u.name).toBeNull();
  });

  it("findByToken returns the user when the hash matches", async () => {
    await ctx.repo.create({ name: "alice", token: "hash-1" });
    const hit = await ctx.repo.findByToken("hash-1");
    expect(hit?.name).toBe("alice");
    const miss = await ctx.repo.findByToken("hash-NOPE");
    expect(miss).toBeNull();
  });

  it("findById returns null for a missing id", async () => {
    expect(await ctx.repo.findById("nope")).toBeNull();
  });

  it("findAll returns every row", async () => {
    await ctx.repo.create({ name: "a", token: "t-a" });
    await ctx.repo.create({ name: "b", token: "t-b" });
    const all = await ctx.repo.findAll();
    expect(all.map(u => u.name).sort()).toEqual(["a", "b"]);
  });

  it("update can change name only, preserving status", async () => {
    const u = await ctx.repo.create({ name: "old", token: "t" });
    const after = await ctx.repo.update(u.id, { name: "new" });
    expect(after?.name).toBe("new");
    expect(after?.status).toBe("active");
  });

  it("update can deactivate a user (status='disabled')", async () => {
    const u = await ctx.repo.create({ name: "x", token: "t" });
    const after = await ctx.repo.update(u.id, { status: "disabled" });
    expect(after?.status).toBe("disabled");
  });

  it("update returns null for a missing id", async () => {
    expect(await ctx.repo.update("nope", { name: "x" })).toBeNull();
  });

  it("update bumps updatedAt without touching createdAt", async () => {
    const u = await ctx.repo.create({ name: "x", token: "t" });
    await new Promise(r => setTimeout(r, 5));
    const after = await ctx.repo.update(u.id, { name: "y" });
    expect(after!.createdAt).toBe(u.createdAt);
    expect(after!.updatedAt).toBeGreaterThan(u.updatedAt!);
  });

  it("updateToken rotates the token (regenerate flow)", async () => {
    const u = await ctx.repo.create({ name: "x", token: "old-hash" });
    await ctx.repo.updateToken(u.id, "new-hash");
    expect(await ctx.repo.findByToken("old-hash")).toBeNull();
    expect((await ctx.repo.findByToken("new-hash"))?.id).toBe(u.id);
  });

  it("delete returns true when a row was removed, false otherwise", async () => {
    const u = await ctx.repo.create({ name: "x", token: "t" });
    expect(await ctx.repo.delete(u.id)).toBe(true);
    expect(await ctx.repo.delete(u.id)).toBe(false);
    expect(await ctx.repo.findById(u.id)).toBeNull();
  });

  it("token UNIQUE constraint rejects duplicate hashes (collision detection)", async () => {
    await ctx.repo.create({ token: "shared" });
    await expect(ctx.repo.create({ token: "shared" })).rejects.toThrow(/UNIQUE/);
  });
});
