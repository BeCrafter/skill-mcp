import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { TenantRepository } from "../../../src/db/repositories/tenant.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; repo: TenantRepository } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  return { db, repo: new TenantRepository(db) };
}

describe("TenantRepository (P0-3)", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("findById returns null when not present", async () => {
    expect(await ctx.repo.findById("default")).toBeNull();
  });

  it("ensureDefault seeds the default tenant on first call and is idempotent", async () => {
    const a = await ctx.repo.ensureDefault();
    expect(a.id).toBe("default");
    expect(a.name).toBe("Default Tenant");
    expect(a.status).toBe("active");

    const b = await ctx.repo.ensureDefault();
    expect(b.id).toBe(a.id);
    expect(b.createdAt).toBe(a.createdAt);
    expect((await ctx.repo.findAll()).length).toBe(1);
  });

  it("create persists arbitrary tenants", async () => {
    const t = await ctx.repo.create({ id: "acme", name: "Acme Corp", description: "demo" });
    expect(t.id).toBe("acme");
    expect(t.description).toBe("demo");
    expect(t.status).toBe("active");
  });
});
