import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { OidcProvisioner } from "../../../src/auth/oidc-provisioner.js";
import { OidcIdentityRepository } from "../../../src/db/repositories/oidc-identity.repository.js";
import { OidcGroupRoleMapRepository } from "../../../src/db/repositories/oidc-group-role-map.repository.js";
import { UserRepository } from "../../../src/db/repositories/user.repository.js";
import { UserRoleRepository } from "../../../src/db/repositories/user-role.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  // Set up the minimum schema the provisioner exercises end-to-end.
  db.run(`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT,
    token TEXT NOT NULL UNIQUE,
    status TEXT DEFAULT 'active',
    token_expires_at INTEGER,
    previous_token TEXT,
    previous_token_expires_at INTEGER,
    created_at INTEGER,
    updated_at INTEGER
  )`);
  db.run(`CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    tags TEXT NOT NULL,
    created_at INTEGER,
    updated_at INTEGER
  )`);
  db.run(`CREATE TABLE user_roles (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    created_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE UNIQUE INDEX uk_user_roles_user_role ON user_roles (user_id, role_id)`);
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

  // Seed two roles with distinct tag sets so we can verify tag aggregation.
  sqlite.prepare(`INSERT INTO roles (id, name, tags) VALUES ('r-fe', 'frontend', '["fe","js"]')`).run();
  sqlite.prepare(`INSERT INTO roles (id, name, tags) VALUES ('r-be', 'backend', '["be","go"]')`).run();
  sqlite.prepare(`INSERT INTO roles (id, name, tags) VALUES ('r-ops', 'ops', '["ops"]')`).run();

  const identityRepo = new OidcIdentityRepository(db);
  const groupRoleMapRepo = new OidcGroupRoleMapRepository(db);
  const userRepo = new UserRepository(db);
  const userRoleRepo = new UserRoleRepository(db);
  const provisioner = new OidcProvisioner({
    identityRepo,
    groupRoleMapRepo,
    userRepo,
    userRoleRepo,
  });
  return { db: db as DrizzleDB, sqlite, identityRepo, groupRoleMapRepo, userRepo, userRoleRepo, provisioner };
}

describe("OidcProvisioner", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("returns null for payload with non-string subject", async () => {
    const result = await ctx.provisioner.provisionFromJwt({ iss: "iss", sub: undefined as unknown as string });
    expect(result).toBeNull();
  });

  it("returns null for payload with missing iss claim", async () => {
    const result = await ctx.provisioner.provisionFromJwt({ sub: "alice" });
    expect(result).toBeNull();
  });

  it("creates a user + identity row on first sight", async () => {
    const result = await ctx.provisioner.provisionFromJwt({
      iss: "https://idp.example.com",
      sub: "alice",
    });
    expect(result).not.toBeNull();
    expect(result!.isNewUser).toBe(true);
    const identity = await ctx.identityRepo.findByIssuerSubject("https://idp.example.com", "alice");
    expect(identity).not.toBeNull();
    expect(identity!.userId).toBe(result!.userId);
    const user = await ctx.userRepo.findById(result!.userId);
    expect(user).not.toBeNull();
    expect(user!.name).toBe("oidc:https://idp.example.com:alice");
  });

  it("returns the same userId on second sight (idempotent)", async () => {
    const a = await ctx.provisioner.provisionFromJwt({ iss: "iss", sub: "alice" });
    const b = await ctx.provisioner.provisionFromJwt({ iss: "iss", sub: "alice" });
    expect(a!.userId).toBe(b!.userId);
    expect(a!.isNewUser).toBe(true);
    expect(b!.isNewUser).toBe(false);
  });

  it("touches lastSeenAt on subsequent visits", async () => {
    const a = await ctx.provisioner.provisionFromJwt({ iss: "iss", sub: "alice" });
    const initial = await ctx.identityRepo.findByIssuerSubject("iss", "alice");
    await new Promise((r) => setTimeout(r, 5));
    await ctx.provisioner.provisionFromJwt({ iss: "iss", sub: "alice" });
    const after = await ctx.identityRepo.findByIssuerSubject("iss", "alice");
    expect(after!.lastSeenAt).toBeGreaterThan(initial!.lastSeenAt);
    expect(a).not.toBeNull();
  });

  it("seeds user_roles from group→role mapping on first sight", async () => {
    await ctx.groupRoleMapRepo.create({ tenantId: "default", groupName: "engineering", roleId: "r-fe" });
    await ctx.groupRoleMapRepo.create({ tenantId: "default", groupName: "engineering", roleId: "r-be" });
    const result = await ctx.provisioner.provisionFromJwt({
      iss: "iss",
      sub: "alice",
      groups: ["engineering"],
    });
    expect(result!.tags.sort()).toEqual(["be", "fe", "go", "js"]);
    const grants = await ctx.userRoleRepo.findRoleIdsByUserId(result!.userId);
    expect(grants.sort()).toEqual(["r-be", "r-fe"]);
  });

  it("ignores groups that have no mapping", async () => {
    await ctx.groupRoleMapRepo.create({ tenantId: "default", groupName: "engineering", roleId: "r-fe" });
    const result = await ctx.provisioner.provisionFromJwt({
      iss: "iss",
      sub: "alice",
      groups: ["engineering", "marketing"],
    });
    expect(result!.tags.sort()).toEqual(["fe", "js"]);
    const grants = await ctx.userRoleRepo.findRoleIdsByUserId(result!.userId);
    expect(grants).toEqual(["r-fe"]);
  });

  it("adds new mapped roles on later visits without dropping manually-granted roles", async () => {
    // First visit grants r-fe via mapping.
    await ctx.groupRoleMapRepo.create({ tenantId: "default", groupName: "engineering", roleId: "r-fe" });
    const first = await ctx.provisioner.provisionFromJwt({ iss: "iss", sub: "alice", groups: ["engineering"] });
    // Operator manually grants r-ops (outside SSO).
    await ctx.userRoleRepo.replaceUserRoles(first!.userId, ["r-fe", "r-ops"]);
    // Operator wires a new mapping engineering -> r-be.
    await ctx.groupRoleMapRepo.create({ tenantId: "default", groupName: "engineering", roleId: "r-be" });
    // Second visit should ADD r-be while keeping r-fe + r-ops.
    const second = await ctx.provisioner.provisionFromJwt({ iss: "iss", sub: "alice", groups: ["engineering"] });
    const grants = await ctx.userRoleRepo.findRoleIdsByUserId(second!.userId);
    expect(grants.sort()).toEqual(["r-be", "r-fe", "r-ops"]);
  });

  it("uses custom userClaim and groupsClaim when provided", async () => {
    await ctx.groupRoleMapRepo.create({ tenantId: "default", groupName: "ops", roleId: "r-ops" });
    const result = await ctx.provisioner.provisionFromJwt(
      { iss: "iss", email: "alice@example.com", roles: ["ops"] },
      { userClaim: "email", groupsClaim: "roles" },
    );
    expect(result).not.toBeNull();
    expect(result!.tags).toContain("ops");
    const identity = await ctx.identityRepo.findByIssuerSubject("iss", "alice@example.com");
    expect(identity).not.toBeNull();
  });

  it("ignores non-string entries in groups claim", async () => {
    await ctx.groupRoleMapRepo.create({ tenantId: "default", groupName: "engineering", roleId: "r-fe" });
    const result = await ctx.provisioner.provisionFromJwt({
      iss: "iss",
      sub: "alice",
      groups: ["engineering", 42, null, ""] as unknown as string[],
    });
    expect(result!.tags).toContain("fe");
  });
});
