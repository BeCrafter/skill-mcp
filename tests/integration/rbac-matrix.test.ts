import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../../src/db/migrate.js";
import { ensureDistBuilt, getFreePort, sha256, spawnHttpServer, type SpawnedServer } from "./_helpers.js";

/**
 * RBAC 端到端验收 — 对 docs/permission-control.md 的用户操作权限矩阵做真实
 * HTTP 效果验证。校验 src/http/handlers/admin/users.handler.ts 中 assertCanOperateOn
 * 的实际行为：自我操作（自改/自删/自轮换）在 HTTP 路径允许；跨超管/跨 admin 拒绝；
 * 超管互保；admin/superadmin 创建需 superadmin。
 *
 * 状态污染注意：rotate-token 会使旧 token 失效、delete 会移除用户。变更类用例
 * 各用专用用户（admin_rot / admin_del），不与后续用例复用同一身份。
 */

interface SeededUser { id: string; token: string; }

function seedUser(db: Database.Database, userType: string, token: string): SeededUser {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, name, username, user_type, token, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `${userType}-${id.slice(0, 8)}`, `${userType}-${id.slice(0, 8)}`, userType, sha256(token), "active", now, now);
  return { id, token };
}

let dataDir: string;
let dbPath: string;
let skillsDir: string;
let server: SpawnedServer;
// super1/super2/admin1/admin2 贯穿用例；admin_rot 仅供自轮换；admin_del 仅供自删；plain 非管理员。
let super1: SeededUser; let super2: SeededUser;
let admin1: SeededUser; let admin2: SeededUser;
let adminRot: SeededUser; let adminDel: SeededUser;
let plain: SeededUser;

const T = (u: SeededUser) => ({ "Authorization": `Bearer ${u.token}` });
const put = (u: SeededUser, path: string) => fetch(`${server.url}${path}`, {
  method: "PUT", headers: { ...T(u), "Content-Type": "application/json" }, body: JSON.stringify({ name: "renamed" }),
});

beforeAll(async () => {
  ensureDistBuilt();
  dataDir = mkdtempSync(join(tmpdir(), "rbac-e2e-"));
  dbPath = join(dataDir, "skill-mcp.db");
  skillsDir = join(dataDir, "skills");
  runMigrations(dbPath);

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  super1 = seedUser(db, "superadmin", "tok-super1");
  super2 = seedUser(db, "superadmin", "tok-super2");
  admin1 = seedUser(db, "admin", "tok-admin1");
  admin2 = seedUser(db, "admin", "tok-admin2");
  adminRot = seedUser(db, "admin", "tok-admin-rot");
  adminDel = seedUser(db, "admin", "tok-admin-del");
  plain = seedUser(db, "user", "tok-plain");
  db.close();

  const port = await getFreePort();
  server = await spawnHttpServer({
    port,
    env: {
      DATABASE_PATH: dbPath,
      STORAGE_BASE_PATH: skillsDir,
      TRANSPORT_TYPE: "http",
      TRANSPORT_PORT: String(port),
    },
  });
}, 60_000);

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("RBAC matrix — self-operation hardened (self-mutate blocked; superadmin self-modify allowed; self-delete forbidden)", () => {
  it("admin cannot modify self (needs superadmin)", async () => {
    expect((await put(admin1, `/api/v1/admin/users/${admin1.id}`)).status).toBe(403);
  });
  it("admin cannot rotate own token (needs superadmin)", async () => {
    expect((await fetch(`${server.url}/api/v1/admin/users/${adminRot.id}/rotate-token`, { method: "POST", headers: T(adminRot) })).status).toBe(403);
  });
  it("admin cannot delete self", async () => {
    expect((await fetch(`${server.url}/api/v1/admin/users/${adminDel.id}`, { method: "DELETE", headers: T(adminDel) })).status).toBe(403);
  });
  it("superadmin can modify self", async () => {
    expect((await put(super1, `/api/v1/admin/users/${super1.id}`)).status).toBe(200);
  });
  it("superadmin cannot delete self (self-delete forbidden for all)", async () => {
    expect((await fetch(`${server.url}/api/v1/admin/users/${super1.id}`, { method: "DELETE", headers: T(super1) })).status).toBe(403);
  });
});

describe("RBAC matrix — cross-user rejected (403 ⇒ target not mutated)", () => {
  it("admin cannot modify another admin", async () => {
    expect((await put(admin1, `/api/v1/admin/users/${admin2.id}`)).status).toBe(403);
  });
  it("admin cannot rotate another admin's token", async () => {
    expect((await fetch(`${server.url}/api/v1/admin/users/${admin2.id}/rotate-token`, { method: "POST", headers: T(admin1) })).status).toBe(403);
  });
  it("admin cannot delete another admin", async () => {
    expect((await fetch(`${server.url}/api/v1/admin/users/${admin2.id}`, { method: "DELETE", headers: T(admin1) })).status).toBe(403);
  });
  it("admin cannot modify a superadmin", async () => {
    expect((await put(admin1, `/api/v1/admin/users/${super1.id}`)).status).toBe(403);
  });
  it("admin cannot delete a superadmin", async () => {
    expect((await fetch(`${server.url}/api/v1/admin/users/${super1.id}`, { method: "DELETE", headers: T(admin1) })).status).toBe(403);
  });
  it("superadmin cannot modify another superadmin (mutual protection)", async () => {
    expect((await put(super1, `/api/v1/admin/users/${super2.id}`)).status).toBe(403);
  });
  it("superadmin cannot delete another superadmin", async () => {
    expect((await fetch(`${server.url}/api/v1/admin/users/${super2.id}`, { method: "DELETE", headers: T(super1) })).status).toBe(403);
  });
});

describe("RBAC matrix — superadmin over admin/user", () => {
  it("superadmin can modify an admin", async () => {
    expect((await put(super1, `/api/v1/admin/users/${admin1.id}`)).status).toBe(200);
  });
  it("superadmin can delete an admin", async () => {
    expect((await fetch(`${server.url}/api/v1/admin/users/${admin1.id}`, { method: "DELETE", headers: T(super1) })).status).toBe(200);
  });
});

describe("RBAC matrix — user creation privilege", () => {
  it("admin cannot create an admin user (requireSuperadmin)", async () => {
    const r = await fetch(`${server.url}/api/v1/admin/users`, {
      method: "POST", headers: { ...T(admin2), "Content-Type": "application/json" },
      body: JSON.stringify({ username: "newadmin", user_type: "admin" }),
    });
    expect(r.status).toBe(403);
  });
  it("superadmin can create an admin user", async () => {
    const r = await fetch(`${server.url}/api/v1/admin/users`, {
      method: "POST", headers: { ...T(super1), "Content-Type": "application/json" },
      body: JSON.stringify({ username: "newadmin-by-super", user_type: "admin", password: "password123" }),
    });
    expect(r.status).toBe(201);
  });
});

describe("RBAC matrix — admin-gate enforcement", () => {
  it("non-admin user is rejected from admin endpoints", async () => {
    expect((await fetch(`${server.url}/api/v1/admin/users`, { headers: T(plain) })).status).toBe(403);
  });
  it("unauthenticated request is rejected", async () => {
    expect((await fetch(`${server.url}/api/v1/admin/users`)).status).toBe(401);
  });
});
