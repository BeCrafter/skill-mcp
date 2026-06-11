import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { OidcIdentityRepository } from "../../../src/db/repositories/oidc-identity.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; sqlite: Database.Database; repo: OidcIdentityRepository } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  // Minimal users table — only the columns the FK / repo actually touch.
  db.run(`CREATE TABLE users (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT, token TEXT NOT NULL UNIQUE, status TEXT,
    token_expires_at INTEGER, previous_token TEXT, previous_token_expires_at INTEGER,
    created_at INTEGER, updated_at INTEGER
  )`);
  db.run(`CREATE TABLE oidc_identities (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE UNIQUE INDEX uk_oidc_identities_issuer_subject ON oidc_identities (issuer, subject)`);
  db.run(`CREATE INDEX idx_oidc_identities_user_id ON oidc_identities (user_id)`);

  // Seed a user
  sqlite.prepare(`INSERT INTO users (id, name, token) VALUES ('u1', 'alice', 'tok-1')`).run();
  sqlite.prepare(`INSERT INTO users (id, name, token) VALUES ('u2', 'bob', 'tok-2')`).run();

  return { db, sqlite, repo: new OidcIdentityRepository(db) };
}

describe("OidcIdentityRepository", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("create persists row and findByIssuerSubject reads it back", async () => {
    const created = await ctx.repo.create({
      issuer: "https://idp.example.com",
      subject: "alice",
      userId: "u1",
    });
    expect(created.userId).toBe("u1");
    const found = await ctx.repo.findByIssuerSubject("https://idp.example.com", "alice");
    expect(found?.id).toBe(created.id);
    expect(found?.tenantId).toBe("default");
  });

  it("findByIssuerSubject returns null when no row matches", async () => {
    const found = await ctx.repo.findByIssuerSubject("https://idp.example.com", "ghost");
    expect(found).toBeNull();
  });

  it("uniqueness on (issuer, subject) blocks duplicates", async () => {
    await ctx.repo.create({ issuer: "iss", subject: "alice", userId: "u1" });
    await expect(
      ctx.repo.create({ issuer: "iss", subject: "alice", userId: "u2" }),
    ).rejects.toThrow();
  });

  it("findByUserId returns all identities for a user", async () => {
    await ctx.repo.create({ issuer: "iss-a", subject: "alice", userId: "u1" });
    await ctx.repo.create({ issuer: "iss-b", subject: "alice", userId: "u1" });
    const rows = await ctx.repo.findByUserId("u1");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.issuer).sort()).toEqual(["iss-a", "iss-b"]);
  });

  it("touchLastSeen updates only the named row", async () => {
    const a = await ctx.repo.create({ issuer: "iss", subject: "alice", userId: "u1" });
    const b = await ctx.repo.create({ issuer: "iss", subject: "bob", userId: "u2" });
    await new Promise((r) => setTimeout(r, 5));
    await ctx.repo.touchLastSeen(a.id);
    const reloadA = await ctx.repo.findByIssuerSubject("iss", "alice");
    const reloadB = await ctx.repo.findByIssuerSubject("iss", "bob");
    expect(reloadA!.lastSeenAt).toBeGreaterThan(a.lastSeenAt);
    expect(reloadB!.lastSeenAt).toBe(b.lastSeenAt);
  });

  it("deleteByUserId cascades only that user's rows", async () => {
    await ctx.repo.create({ issuer: "iss-a", subject: "alice", userId: "u1" });
    await ctx.repo.create({ issuer: "iss-b", subject: "bob", userId: "u2" });
    await ctx.repo.deleteByUserId("u1");
    expect(await ctx.repo.findByUserId("u1")).toEqual([]);
    expect((await ctx.repo.findByUserId("u2")).length).toBe(1);
  });

  it("FK cascade on user delete removes identity rows", async () => {
    await ctx.repo.create({ issuer: "iss", subject: "alice", userId: "u1" });
    ctx.sqlite.prepare(`DELETE FROM users WHERE id = 'u1'`).run();
    expect(await ctx.repo.findByUserId("u1")).toEqual([]);
  });
});
