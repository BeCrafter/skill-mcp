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
    id TEXT PRIMARY KEY, name TEXT, username TEXT, password_hash TEXT,
    user_type TEXT DEFAULT 'user',
    token TEXT NOT NULL UNIQUE,
    token_plaintext TEXT,
    status TEXT DEFAULT 'active',
    token_expires_at INTEGER,
    previous_token TEXT,
    previous_token_expires_at INTEGER,
    created_at INTEGER, updated_at INTEGER
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

  describe("token expiration + rotation (P0-4)", () => {
    it("create accepts tokenExpiresAt and persists it", async () => {
      const future = Date.now() + 10_000;
      const u = await ctx.repo.create({ name: "x", token: "t-1", tokenExpiresAt: future });
      expect(u.tokenExpiresAt).toBe(future);
    });

    it("findByToken returns null for an expired primary token", async () => {
      const past = Date.now() - 1;
      await ctx.repo.create({ name: "x", token: "t-expired", tokenExpiresAt: past });
      expect(await ctx.repo.findByToken("t-expired")).toBeNull();
    });

    it("rotateToken moves old hash into previous slot with a grace expiry", async () => {
      const u = await ctx.repo.create({ name: "x", token: "old-hash" });
      const rotated = await ctx.repo.rotateToken(u.id, "new-hash", { graceMs: 60_000 });
      expect(rotated?.token).toBe("new-hash");
      expect(rotated?.previousToken).toBe("old-hash");
      expect(rotated?.previousTokenExpiresAt).toBeGreaterThan(Date.now());
    });

    it("findByToken accepts BOTH old and new tokens during the grace window", async () => {
      const u = await ctx.repo.create({ name: "x", token: "old-hash" });
      await ctx.repo.rotateToken(u.id, "new-hash", { graceMs: 60_000 });
      const viaNew = await ctx.repo.findByToken("new-hash");
      const viaOld = await ctx.repo.findByToken("old-hash");
      expect(viaNew?.id).toBe(u.id);
      expect(viaOld?.id).toBe(u.id);
    });

    it("findByToken rejects the previous token after the grace window passes", async () => {
      const u = await ctx.repo.create({ name: "x", token: "old-hash" });
      await ctx.repo.rotateToken(u.id, "new-hash", { graceMs: 0 });
      const viaOld = await ctx.repo.findByToken("old-hash");
      expect(viaOld).toBeNull();
      const viaNew = await ctx.repo.findByToken("new-hash");
      expect(viaNew?.id).toBe(u.id);
    });

    it("clearPreviousToken nukes the grace slot immediately", async () => {
      const u = await ctx.repo.create({ name: "x", token: "old-hash" });
      await ctx.repo.rotateToken(u.id, "new-hash", { graceMs: 60_000 });
      await ctx.repo.clearPreviousToken(u.id);
      expect(await ctx.repo.findByToken("old-hash")).toBeNull();
      const after = await ctx.repo.findById(u.id);
      expect(after?.previousToken).toBeNull();
      expect(after?.previousTokenExpiresAt).toBeNull();
    });

    it("rotateToken returns null for a missing user", async () => {
      expect(await ctx.repo.rotateToken("nope", "new-hash")).toBeNull();
    });

    it("rotateToken honors per-rotation tokenExpiresAt for the new token", async () => {
      const future = Date.now() + 5_000;
      const u = await ctx.repo.create({ name: "x", token: "old-hash" });
      const rotated = await ctx.repo.rotateToken(u.id, "new-hash", { tokenExpiresAt: future });
      expect(rotated?.tokenExpiresAt).toBe(future);
    });
  });
});
