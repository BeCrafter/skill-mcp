/**
 * CLI role-command permission tests (TC-03, TC-05, TC-09, TC-10, TC-11, TC-12)
 *
 * These tests exercise the built-in role protection guards in
 * `src/cli/commands/role-cmd.ts` by calling the exported action functions
 * with a real in-memory SQLite database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mocks ──────────────────────────────────────────────────────────

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

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
    this.name = "ExitError";
  }
}
const mockExit = vi.fn((code?: number) => {
  throw new ExitError(code ?? 0);
});

let consoleOutput: string[];
const mockConsoleLog = vi.fn((...args: unknown[]) => {
  consoleOutput.push(args.map(String).join(" "));
});
const mockConsoleError = vi.fn((...args: unknown[]) => {
  consoleOutput.push(args.map(String).join(" "));
});

// Use real getDatabase (returns Drizzle ORM instance) — only mock closeDatabase
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

import {
  roleCreateAction,
  roleUpdateAction,
  roleDeleteAction,
} from "../../../src/cli/commands/role-cmd.js";
import { requireAuth } from "../../../src/cli/commands/auth-cmd.js";
import { runMigrations } from "../../../src/db/migrate.js";

// ── Helpers ────────────────────────────────────────────────────────

function seedUser(db: Database.Database, opts: {
  id: string; username: string; userType: string; status?: string;
}): void {
  const token = `tok-${opts.id}`;
  db.prepare(
    `INSERT INTO users (id, username, token, user_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(opts.id, opts.username, token, opts.userType, opts.status ?? "active", Date.now(), Date.now());
}

function seedRole(db: Database.Database, opts: { id: string; name: string; tags?: string[] }): void {
  db.prepare(
    `INSERT INTO roles (id, name, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.id, opts.name, JSON.stringify(opts.tags ?? []), Date.now(), Date.now());
}

function seedUserRole(db: Database.Database, userId: string, roleId: string): void {
  db.prepare(
    `INSERT INTO user_roles (id, user_id, role_id, created_at)
     VALUES (?, ?, ?, ?)`,
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

describe("CLI role-command permission guards", () => {
  let db: Database.Database;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cli-role-perm-"));
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

  // ── TC-03: 管理员不能删除内置角色 ────────────────────────────────
  describe("TC-03: admin cannot delete built-in roles", () => {
    it("rejects deletion of 'superadmin' role", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedRole(db, { id: "r-sa", name: "superadmin" });
      setCaller("adm-1", "admin");

      await expect(roleDeleteAction("r-sa")).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Cannot delete built-in role");
    });

    it("rejects deletion of 'admin' role", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedRole(db, { id: "r-admin", name: "admin" });
      setCaller("adm-1", "admin");

      await expect(roleDeleteAction("r-admin")).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Cannot delete built-in role");
    });

    it("rejects deletion of 'user' role", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedRole(db, { id: "r-user", name: "user" });
      setCaller("adm-1", "admin");

      await expect(roleDeleteAction("r-user")).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Cannot delete built-in role");
    });
  });

  // ── TC-05: 删除自定义角色后用户角色为空 ──────────────────────────
  describe("TC-05: deleting custom role clears user-role assignments", () => {
    it("removes user-role rows when custom role is deleted", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedUser(db, { id: "u-1", username: "user01", userType: "user" });
      seedRole(db, { id: "r-pm", name: "pm", tags: ["prd"] });
      seedUserRole(db, "u-1", "r-pm");
      setCaller("adm-1", "admin");

      // Verify assignment exists before delete
      const before = db.prepare("SELECT * FROM user_roles WHERE user_id = ?").all("u-1");
      expect(before).toHaveLength(1);

      await roleDeleteAction("r-pm");

      const after = db.prepare("SELECT * FROM user_roles WHERE user_id = ?").all("u-1");
      expect(after).toHaveLength(0);

      // Role itself should be gone
      const role = db.prepare("SELECT * FROM roles WHERE id = ?").get("r-pm");
      expect(role).toBeUndefined();
    });
  });

  // ── TC-09: 管理员可以创建自定义角色 ──────────────────────────────
  describe("TC-09: admin can create custom role", () => {
    it("succeeds when admin creates a role with a non-reserved name", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      setCaller("adm-1", "admin");

      await roleCreateAction({ name: "qa", tags: ["testing"], description: "QA team" });

      const row = db.prepare("SELECT name, tags FROM roles WHERE name = ?").get("qa") as { name: string; tags: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.name).toBe("qa");
      expect(JSON.parse(row!.tags)).toEqual(["testing"]);
    });
  });

  // ── TC-10: 管理员不能创建内置名称角色 ────────────────────────────
  describe("TC-10: admin cannot create role with built-in name", () => {
    it("rejects creation of 'superadmin' role", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      setCaller("adm-1", "admin");

      await expect(roleCreateAction({ name: "superadmin", tags: ["fake"] })).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Cannot create role with reserved name");
    });

    it("rejects creation of 'admin' role", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      setCaller("adm-1", "admin");

      await expect(roleCreateAction({ name: "admin", tags: ["fake"] })).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Cannot create role with reserved name");
    });

    it("rejects creation of 'user' role", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      setCaller("adm-1", "admin");

      await expect(roleCreateAction({ name: "user", tags: ["fake"] })).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Cannot create role with reserved name");
    });
  });

  // ── TC-11: 管理员可以修改自定义角色 ──────────────────────────────
  describe("TC-11: admin can modify custom role", () => {
    it("succeeds when admin updates a custom role's tags", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedRole(db, { id: "r-qa", name: "qa", tags: ["testing"] });
      setCaller("adm-1", "admin");

      await roleUpdateAction("r-qa", { tags: ["testing", "automation"] });

      const row = db.prepare("SELECT tags FROM roles WHERE id = ?").get("r-qa") as { tags: string } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row!.tags)).toEqual(["testing", "automation"]);
    });
  });

  // ── TC-12: 管理员不能修改内置角色 ────────────────────────────────
  describe("TC-12: admin cannot modify built-in roles", () => {
    it("rejects modification of 'superadmin' role", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedRole(db, { id: "r-sa", name: "superadmin" });
      setCaller("adm-1", "admin");

      await expect(roleUpdateAction("r-sa", { tags: ["fake"] })).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Cannot modify built-in role");
    });

    it("rejects modification of 'admin' role", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedRole(db, { id: "r-admin", name: "admin" });
      setCaller("adm-1", "admin");

      await expect(roleUpdateAction("r-admin", { tags: ["fake"] })).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Cannot modify built-in role");
    });

    it("rejects modification of 'user' role", async () => {
      seedUser(db, { id: "adm-1", username: "admin01", userType: "admin" });
      seedRole(db, { id: "r-user", name: "user" });
      setCaller("adm-1", "admin");

      await expect(roleUpdateAction("r-user", { tags: ["fake"] })).rejects.toThrow(ExitError);

      const output = consoleOutput.join("\n");
      expect(output).toContain("Cannot modify built-in role");
    });
  });
});
