/**
 * CLI user-command permission tests (TC-01, TC-02, TC-04, TC-06, TC-07,
 * TC-08, TC-13, TC-15, TC-16, TC-17, TC-18)
 *
 * These tests exercise the permission guards in `src/cli/commands/user-cmd.ts`
 * by calling the exported action functions with controlled credentials and a
 * real in-memory SQLite database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mocks ──────────────────────────────────────────────────────────
// We must mock modules BEFORE importing the code under test.

let testDbPath: string;
let testDir: string;

vi.mock("../../../src/config/index.js", () => ({
  getConfig: () => ({
    database: { path: testDbPath },
    storage: { type: "local-fs", basePath: join(testDir, "data/skills") },
    cache: { file: { enabled: false, path: "" } },
    app: { env: "test" },
  }),
  getDefaultDataDir: () => testDir,
}));

// Prevent actual process.exit from killing the test runner.
// Instead, throw an ExitError so we can catch it.
class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
    this.name = "ExitError";
  }
}
const mockExit = vi.fn((code?: number) => {
  throw new ExitError(code ?? 0);
});

// Capture console output (both stdout and stderr — `fail()` uses console.error)
let consoleOutput: string[];
const mockConsoleLog = vi.fn((...args: unknown[]) => {
  consoleOutput.push(args.map(String).join(" "));
});
const mockConsoleError = vi.fn((...args: unknown[]) => {
  consoleOutput.push(args.map(String).join(" "));
});

// Use real getDatabase (returns Drizzle ORM instance) — only mock closeDatabase
// to prevent it from being called during test cleanup.
vi.mock("../../../src/db/connection.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/db/connection.js")>(
    "../../../src/db/connection.js",
  );
  return { ...actual, closeDatabase: vi.fn() };
});

vi.mock("../../../src/cli/commands/auth-cmd.js", () => ({
  requireAuth: vi.fn(),
  readCredentials: vi.fn(),
}));

// ── Imports (after mocks) ──────────────────────────────────────────
import {
  userCreateAction,
  userDeleteAction,
  userAssignRolesAction,
  userRotateTokenAction,
} from "../../../src/cli/commands/user-cmd.js";
import { requireAuth } from "../../../src/cli/commands/auth-cmd.js";
import { runMigrations } from "../../../src/db/migrate.js";

// ── Helpers ────────────────────────────────────────────────────────

function seedUser(db: Database.Database, opts: {
  id: string; username: string; userType: string; status?: string;
}): void {
  const token = `tok-${opts.id}`;
  db.prepare(
    `INSERT INTO users (id, username, token, user_type, status, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'default', ?, ?)`,
  ).run(opts.id, opts.username, token, opts.userType, opts.status ?? "active", Date.now(), Date.now());
}

function seedRole(db: Database.Database, opts: { id: string; name: string; tags?: string[] }): void {
  db.prepare(
    `INSERT INTO roles (id, name, tags, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, 'default', ?, ?)`,
  ).run(opts.id, opts.name, JSON.stringify(opts.tags ?? []), Date.now(), Date.now());
}

function seedUserRole(db: Database.Database, userId: string, roleId: string): void {
  db.prepare(
    `INSERT INTO user_roles (id, tenant_id, user_id, role_id, created_at)
     VALUES (?, 'default', ?, ?, ?)`,
  ).run(`ur-${userId}-${roleId}`, userId, roleId, Date.now());
}

function setCaller(userId: string, userType: string) {
  vi.mocked(requireAuth).mockReturnValue({
    userId,
    username: `caller-${userId}`,
    userType,
    accessToken: "fake-jwt",
    refreshToken: "fake-refresh",
    expiresAt: Date.now() + 3600_000,
  } as never);
}

// ── Test suite ─────────────────────────────────────────────────────

describe("CLI user-command permission guards", () => {
  let db: Database.Database;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cli-user-perm-"));
    testDbPath = join(testDir, "skill-mcp.db");
    runMigrations(testDbPath);
    db = new Database(testDbPath);
    db.pragma("foreign_keys = ON");

    consoleOutput = [];
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.spyOn(console, "log").mockImplementation(mockConsoleLog);
    vi.spyOn(console, "error").mockImplementation(mockConsoleError);
    vi.spyOn(process, "exit").mockImplementation(mockExit as never);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── TC-01: 管理员不能删除超级管理员 ──────────────────────────────
  describe("TC-01: admin cannot delete superadmin", () => {
    it("rejects with exit(1) when admin tries to delete superadmin", async () => {
      seedUser(db, { id: "sa-1", username: "superadmin", userType: "superadmin" });
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      setCaller("adm-1", "admin");

      await expect(userDeleteAction("sa-1")).rejects.toThrow(ExitError);

      // Superadmin must still exist
      const row = db.prepare("SELECT id FROM users WHERE id = ?").get("sa-1");
      expect(row).toBeDefined();
    });
  });

  // ── TC-02: 管理员不能删除自己 ────────────────────────────────────
  describe("TC-02: admin cannot delete self", () => {
    it("rejects when admin tries to delete their own account", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      setCaller("adm-1", "admin");

      // userDeleteAction checks userId === creds.userId and calls fail() + return (no exit)
      await userDeleteAction("adm-1");

      // Admin must still exist
      const row = db.prepare("SELECT id FROM users WHERE id = ?").get("adm-1");
      expect(row).toBeDefined();
      // Should have printed failure message
      const output = consoleOutput.join("\n");
      expect(output).toContain("Cannot delete your own account");
    });
  });

  // ── TC-04: 管理员可以为普通用户授予普通角色 ──────────────────────
  describe("TC-04: admin can assign normal roles to normal user", () => {
    it("succeeds when admin assigns a custom role to a normal user", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedUser(db, { id: "u-1", username: "user01", userType: "user" });
      seedRole(db, { id: "r-dev", name: "dev", tags: ["rd"] });
      setCaller("adm-1", "admin");

      await userAssignRolesAction("u-1", ["r-dev"]);

      const assigned = db.prepare("SELECT role_id FROM user_roles WHERE user_id = ?").all("u-1") as Array<{ role_id: string }>;
      expect(assigned.map(r => r.role_id)).toContain("r-dev");
    });
  });

  // ── TC-06: 管理员可以删除普通用户 ────────────────────────────────
  describe("TC-06: admin can delete normal user", () => {
    it("succeeds when admin deletes a normal user", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedUser(db, { id: "u-2", username: "user02", userType: "user" });
      setCaller("adm-1", "admin");

      await userDeleteAction("u-2");

      const row = db.prepare("SELECT id FROM users WHERE id = ?").get("u-2");
      expect(row).toBeUndefined();
    });
  });

  // ── TC-07: 管理员不能创建管理员用户 ──────────────────────────────
  describe("TC-07: admin cannot create admin user", () => {
    it("rejects when admin tries to create admin user", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      // Seed built-in roles so initRepos works
      seedRole(db, { id: "r-admin", name: "admin" });
      seedRole(db, { id: "r-user", name: "user" });
      seedRole(db, { id: "r-sa", name: "superadmin" });
      setCaller("adm-1", "admin");

      await expect(userCreateAction({
        username: "admin02",
        password: "admin888",
        userType: "admin",
      })).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Only superadmin can create admin/superadmin users");
    });

    it("rejects when admin tries to create superadmin user", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedRole(db, { id: "r-admin", name: "admin" });
      seedRole(db, { id: "r-user", name: "user" });
      seedRole(db, { id: "r-sa", name: "superadmin" });
      setCaller("adm-1", "admin");

      await expect(userCreateAction({
        username: "super02",
        password: "admin888",
        userType: "superadmin",
      })).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Only superadmin can create admin/superadmin users");
    });
  });

  // ── TC-08: 管理员不能将 superadmin/admin 角色分配给用户 ──────────
  describe("TC-08: admin cannot assign privileged roles", () => {
    it("rejects when admin assigns superadmin role to user", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedUser(db, { id: "u-1", username: "user01", userType: "user" });
      seedRole(db, { id: "r-sa", name: "superadmin" });
      setCaller("adm-1", "admin");

      await expect(userAssignRolesAction("u-1", ["r-sa"])).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Only superadmin can assign superadmin/admin roles");
    });

    it("rejects when admin assigns admin role to user", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedUser(db, { id: "u-1", username: "user01", userType: "user" });
      seedRole(db, { id: "r-admin", name: "admin" });
      setCaller("adm-1", "admin");

      await expect(userAssignRolesAction("u-1", ["r-admin"])).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Only superadmin can assign superadmin/admin roles");
    });
  });

  // ── TC-13: 管理员不能轮换其他管理员的 token ─────────────────────
  describe("TC-13: admin cannot rotate token of another admin", () => {
    it("rejects when admin tries to rotate another admin's token", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedUser(db, { id: "adm-2", username: "admin02", userType: "admin" });
      setCaller("adm-1", "admin");

      await expect(userRotateTokenAction("adm-2")).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Only superadmin can operate on admin users");
    });
  });

  // ── TC-15: 普通用户无密码 ────────────────────────────────────────
  describe("TC-15: normal user created without password", () => {
    it("creates user without password when --password is omitted", async () => {
      seedUser(db, { id: "sa-1", username: "superadmin", userType: "superadmin" });
      seedRole(db, { id: "r-user", name: "user" });
      seedRole(db, { id: "r-admin", name: "admin" });
      seedRole(db, { id: "r-sa", name: "superadmin" });
      setCaller("sa-1", "superadmin");

      await userCreateAction({ username: "user01", userType: "user" });

      const row = db.prepare("SELECT password_hash FROM users WHERE username = ?").get("user01") as { password_hash: string | null } | undefined;
      expect(row).toBeDefined();
      expect(row!.password_hash).toBeNull();
    });
  });

  // ── TC-16: 超级管理员可以创建第二个超级管理员 ────────────────────
  describe("TC-16: superadmin can create another superadmin", () => {
    it("succeeds when superadmin creates a new superadmin", async () => {
      seedUser(db, { id: "sa-1", username: "superadmin", userType: "superadmin" });
      seedRole(db, { id: "r-user", name: "user" });
      seedRole(db, { id: "r-admin", name: "admin" });
      seedRole(db, { id: "r-sa", name: "superadmin" });
      setCaller("sa-1", "superadmin");

      await userCreateAction({ username: "super02", password: "admin888", userType: "superadmin" });

      const row = db.prepare("SELECT id, user_type FROM users WHERE username = ?").get("super02") as { id: string; user_type: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.user_type).toBe("superadmin");
    });
  });

  // ── TC-17: 第二个超管不能删除第一个超管 ──────────────────────────
  describe("TC-17: second superadmin cannot delete first superadmin", () => {
    it("rejects when super02 tries to delete super01", async () => {
      seedUser(db, { id: "sa-1", username: "superadmin", userType: "superadmin" });
      seedUser(db, { id: "sa-2", username: "super02", userType: "superadmin" });
      setCaller("sa-2", "superadmin");

      await expect(userDeleteAction("sa-1")).rejects.toThrow(ExitError);

      const row = db.prepare("SELECT id FROM users WHERE id = ?").get("sa-1");
      expect(row).toBeDefined();
    });
  });

  // ── TC-18: 第一个超管也不能删除第二个超管 ────────────────────────
  describe("TC-18: first superadmin cannot delete second superadmin", () => {
    it("rejects when super01 tries to delete super02", async () => {
      seedUser(db, { id: "sa-1", username: "superadmin", userType: "superadmin" });
      seedUser(db, { id: "sa-2", username: "super02", userType: "superadmin" });
      setCaller("sa-1", "superadmin");

      await expect(userDeleteAction("sa-2")).rejects.toThrow(ExitError);

      const row = db.prepare("SELECT id FROM users WHERE id = ?").get("sa-2");
      expect(row).toBeDefined();
    });
  });

  // ── TC-19: 管理员不能修改管理员用户 ──────────────────────────────
  // (HTTP-only: CLI 没有 user update 命令，此 TC 通过 HTTP handler 测试覆盖)
  // 见 admin-users-handler.test.ts 中的 TC-19 测试

  // ── TC-20: 超管可以操作自己，不能操作其他超管 ────────────────────
  describe("TC-20: superadmin can operate on self, not on other superadmin", () => {
    it("allows superadmin to rotate their own token", async () => {
      seedUser(db, { id: "sa-1", username: "superadmin", userType: "superadmin" });
      setCaller("sa-1", "superadmin");

      await userRotateTokenAction("sa-1");

      const output = consoleOutput.join("\n");
      expect(output).toContain("token rotated");
    });

    it("rejects when superadmin tries to rotate another superadmin's token", async () => {
      seedUser(db, { id: "sa-1", username: "superadmin", userType: "superadmin" });
      seedUser(db, { id: "sa-2", username: "super02", userType: "superadmin" });
      setCaller("sa-1", "superadmin");

      await expect(userRotateTokenAction("sa-2")).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Cannot operate on superadmin user");
    });
  });

  // ── TC-21: 管理员不能删除管理员 ──────────────────────────────────
  describe("TC-21: admin cannot delete another admin", () => {
    it("rejects when admin tries to delete another admin", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedUser(db, { id: "adm-2", username: "admin02", userType: "admin" });
      setCaller("adm-1", "admin");

      await expect(userDeleteAction("adm-2")).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Only superadmin can operate on admin users");

      const row = db.prepare("SELECT id FROM users WHERE id = ?").get("adm-2");
      expect(row).toBeDefined();
    });
  });

  // ── TC-22: 管理员可以轮换普通用户 token ──────────────────────────
  describe("TC-22: admin can rotate normal user's token", () => {
    it("succeeds when admin rotates a normal user's token", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedUser(db, { id: "u-1", username: "user01", userType: "user" });
      setCaller("adm-1", "admin");

      await userRotateTokenAction("u-1");

      const output = consoleOutput.join("\n");
      expect(output).toContain("token rotated");
    });
  });

  // ── TC-23: 超管可以轮换自己 token，不能轮换其他超管 token ────────
  describe("TC-23: superadmin can rotate own token, not other superadmin's", () => {
    it("allows superadmin to rotate their own token", async () => {
      seedUser(db, { id: "sa-1", username: "superadmin", userType: "superadmin" });
      setCaller("sa-1", "superadmin");

      await userRotateTokenAction("sa-1");

      const output = consoleOutput.join("\n");
      expect(output).toContain("token rotated");
    });

    it("rejects when superadmin tries to rotate another superadmin's token", async () => {
      seedUser(db, { id: "sa-1", username: "superadmin", userType: "superadmin" });
      seedUser(db, { id: "sa-2", username: "super02", userType: "superadmin" });
      setCaller("sa-2", "superadmin");

      await expect(userRotateTokenAction("sa-1")).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Cannot operate on superadmin user");
    });
  });
});
