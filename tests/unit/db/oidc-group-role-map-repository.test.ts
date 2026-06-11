import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { OidcGroupRoleMapRepository } from "../../../src/db/repositories/oidc-group-role-map.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; sqlite: Database.Database; repo: OidcGroupRoleMapRepository } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE roles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
    tags TEXT NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    created_at INTEGER, updated_at INTEGER
  )`);
  db.run(`CREATE TABLE oidc_group_role_map (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    group_name TEXT NOT NULL,
    role_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE UNIQUE INDEX uk_oidc_group_role_map_tenant_group_role
          ON oidc_group_role_map (tenant_id, group_name, role_id)`);
  db.run(`CREATE INDEX idx_oidc_group_role_map_tenant_group
          ON oidc_group_role_map (tenant_id, group_name)`);

  // Seed three roles.
  sqlite.prepare(`INSERT INTO roles (id, name, tags) VALUES ('r1', 'frontend', '["fe"]')`).run();
  sqlite.prepare(`INSERT INTO roles (id, name, tags) VALUES ('r2', 'backend', '["be"]')`).run();
  sqlite.prepare(`INSERT INTO roles (id, name, tags) VALUES ('r3', 'ops', '["ops"]')`).run();

  return { db, sqlite, repo: new OidcGroupRoleMapRepository(db) };
}

describe("OidcGroupRoleMapRepository", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("create + findAllByTenant round-trips a row", async () => {
    await ctx.repo.create({ tenantId: "default", groupName: "engineering", roleId: "r1" });
    const rows = await ctx.repo.findAllByTenant("default");
    expect(rows.length).toBe(1);
    expect(rows[0].groupName).toBe("engineering");
    expect(rows[0].roleId).toBe("r1");
  });

  it("UNIQUE blocks (tenant, group, role) duplicates", async () => {
    await ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r1" });
    await expect(
      ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r1" }),
    ).rejects.toThrow();
  });

  it("multiple roles per group are allowed", async () => {
    await ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r1" });
    await ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r2" });
    const rows = await ctx.repo.findAllByTenant("default");
    expect(rows.length).toBe(2);
  });

  it("findRoleIdsByGroups returns DISTINCT roles for matching groups only", async () => {
    await ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r1" });
    await ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r2" });
    await ctx.repo.create({ tenantId: "default", groupName: "g2", roleId: "r2" });
    await ctx.repo.create({ tenantId: "default", groupName: "g3", roleId: "r3" });
    const ids = await ctx.repo.findRoleIdsByGroups("default", ["g1", "g2"]);
    expect(ids.sort()).toEqual(["r1", "r2"]);
  });

  it("findRoleIdsByGroups returns empty for empty input", async () => {
    expect(await ctx.repo.findRoleIdsByGroups("default", [])).toEqual([]);
  });

  it("findRoleIdsByGroups isolates tenants", async () => {
    await ctx.repo.create({ tenantId: "tenant-a", groupName: "g1", roleId: "r1" });
    await ctx.repo.create({ tenantId: "tenant-b", groupName: "g1", roleId: "r2" });
    expect(await ctx.repo.findRoleIdsByGroups("tenant-a", ["g1"])).toEqual(["r1"]);
    expect(await ctx.repo.findRoleIdsByGroups("tenant-b", ["g1"])).toEqual(["r2"]);
  });

  it("replaceForGroup atomically replaces role list for one group", async () => {
    await ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r1" });
    await ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r2" });
    await ctx.repo.create({ tenantId: "default", groupName: "g2", roleId: "r3" });
    await ctx.repo.replaceForGroup("default", "g1", ["r3"]);
    const rows = await ctx.repo.findAllByTenant("default");
    const g1 = rows.filter((r) => r.groupName === "g1");
    const g2 = rows.filter((r) => r.groupName === "g2");
    expect(g1.length).toBe(1);
    expect(g1[0].roleId).toBe("r3");
    // g2 untouched
    expect(g2.length).toBe(1);
    expect(g2[0].roleId).toBe("r3");
  });

  it("replaceForGroup with empty list deletes all rows for that group", async () => {
    await ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r1" });
    await ctx.repo.replaceForGroup("default", "g1", []);
    const rows = await ctx.repo.findAllByTenant("default");
    expect(rows).toEqual([]);
  });

  it("replaceForGroup dedupes input role IDs", async () => {
    await ctx.repo.replaceForGroup("default", "g1", ["r1", "r1", "r2", "r2"]);
    const rows = await ctx.repo.findAllByTenant("default");
    expect(rows.length).toBe(2);
  });

  it("deleteByGroup removes all rows for a (tenant, group)", async () => {
    await ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r1" });
    await ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r2" });
    const removed = await ctx.repo.deleteByGroup("default", "g1");
    expect(removed).toBe(2);
    expect(await ctx.repo.findAllByTenant("default")).toEqual([]);
  });

  it("deleteById removes only the row with matching id", async () => {
    const a = await ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r1" });
    await ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r2" });
    expect(await ctx.repo.deleteById(a.id)).toBe(true);
    const rows = await ctx.repo.findAllByTenant("default");
    expect(rows.length).toBe(1);
    expect(rows[0].roleId).toBe("r2");
  });

  it("FK cascade on role delete removes mapping rows", async () => {
    await ctx.repo.create({ tenantId: "default", groupName: "g1", roleId: "r1" });
    ctx.sqlite.prepare(`DELETE FROM roles WHERE id = 'r1'`).run();
    const rows = await ctx.repo.findAllByTenant("default");
    expect(rows).toEqual([]);
  });
});
