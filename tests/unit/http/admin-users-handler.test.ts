import { describe, it, expect, vi } from "vitest";
import { Router } from "@/http/router.js";
import { errorMap } from "@/http/middleware/error-map.js";
import { registerAdminUserRoutes } from "@/http/handlers/admin/users.handler.js";
import type { HttpContext } from "@/http/context.js";
import type { AppDependencies } from "@/app-dependencies.js";

function makeRes() {
  let body = "";
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 0,
    writeHead: vi.fn((status: number, h?: Record<string, unknown>) => {
      res.statusCode = status;
      if (h) Object.assign(headers, h);
    }),
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn((chunk?: string | Buffer) => { if (chunk) body += chunk.toString(); }),
    _body: () => body,
  };
  return res as never;
}

function makeCtx(method: string, url: string, body?: unknown): HttpContext {
  const req = {
    headers: {},
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "data" && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
      return this;
    },
  } as never;
  return {
    req, res: makeRes(),
    url, method, params: {}, query: new URLSearchParams(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  };
}

function bodyOf(ctx: HttpContext): { statusCode: number; body: unknown } {
  const r = ctx.res as unknown as { statusCode: number; _body: () => string };
  return { statusCode: r.statusCode, body: r._body() ? JSON.parse(r._body()) : undefined };
}

function setup(overrides: Partial<AppDependencies> = {}): {
  router: Router; userRepo: never; roleRepo: never; userRoleRepo: never; eventBus: { publish: ReturnType<typeof vi.fn> };
} {
  const userRepo = {
    findAll: vi.fn().mockResolvedValue([{ id: "u1", name: "alice" }]),
    findById: vi.fn(async (id: string) => (id === "u1" ? { id: "u1", name: "alice", status: "active" } : null)),
    create: vi.fn(async ({ name }: { name?: string }) => ({ id: "u-new", name: name ?? null })),
    update: vi.fn(async (id: string, fields: Record<string, unknown>) => (id === "u1" ? { id, ...fields } : null)),
    delete: vi.fn(async (id: string) => id === "u1"),
  };
  const roleRepo = {
    findByIds: vi.fn().mockResolvedValue([{ id: "r1", name: "admin", tags: ["alpha"] }]),
  };
  const userRoleRepo = {
    replaceUserRoles: vi.fn().mockResolvedValue(undefined),
    getAggregatedTagsByUserId: vi.fn().mockResolvedValue(["alpha"]),
    findRoleIdsByUserId: vi.fn().mockResolvedValue(["r1"]),
    deleteByUserId: vi.fn().mockResolvedValue(undefined),
  };
  const eventBus = { publish: vi.fn() };

  const router = new Router();
  router.use(errorMap());
  registerAdminUserRoutes(router, {
    userRepo, roleRepo, userRoleRepo, eventBus,
    ...overrides,
  } as unknown as AppDependencies);
  return { router, userRepo: userRepo as never, roleRepo: roleRepo as never, userRoleRepo: userRoleRepo as never, eventBus };
}

describe("registerAdminUserRoutes", () => {
  it("does NOT register routes when dependencies are missing", () => {
    const router = new Router();
    registerAdminUserRoutes(router, { userRepo: undefined } as unknown as AppDependencies);
    expect(router.match("GET", "/api/admin/users")).toBeNull();
  });

  it("GET /api/admin/users returns the full list", async () => {
    const { router, userRepo } = setup();
    const ctx = makeCtx("GET", "/api/admin/users");
    await router.dispatch(ctx);
    expect(userRepo.findAll).toHaveBeenCalled();
    expect(bodyOf(ctx).statusCode).toBe(200);
  });

  it("POST /api/admin/users mints sk-live token, returns plaintext only in 201, persists hash", async () => {
    const { router, userRepo } = setup();
    const ctx = makeCtx("POST", "/api/admin/users", { name: "bob", role_ids: ["r1"] });
    await router.dispatch(ctx);
    const out = bodyOf(ctx);
    expect(out.statusCode).toBe(201);
    const body = out.body as { data: { token: string; roles: string[]; tags: string[] } };
    expect(body.data.token).toMatch(/^sk-live-[0-9a-f]{24}$/);
    // Persisted token must be the SHA-256 hex digest, NOT the plaintext.
    const persistedToken = userRepo.create.mock.calls[0][0].token;
    expect(persistedToken).not.toBe(body.data.token);
    expect(persistedToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.data.roles).toEqual(["admin"]);
    expect(body.data.tags).toEqual(["alpha"]);
  });

  it("POST /api/admin/users without role_ids skips replaceUserRoles", async () => {
    const { router, userRoleRepo } = setup();
    const ctx = makeCtx("POST", "/api/admin/users", { name: "noroles" });
    await router.dispatch(ctx);
    expect(userRoleRepo.replaceUserRoles).not.toHaveBeenCalled();
  });

  it("GET /api/admin/users/:userId returns 404 for unknown id", async () => {
    const { router } = setup();
    const ctx = makeCtx("GET", "/api/admin/users/nope");
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(404);
  });

  it("GET /api/admin/users/:userId returns user with roles and aggregated tags", async () => {
    const { router } = setup();
    const ctx = makeCtx("GET", "/api/admin/users/u1");
    await router.dispatch(ctx);
    const body = bodyOf(ctx).body as { data: { roles: { name: string }[]; tags: string[] } };
    expect(body.data.roles).toEqual([{ id: "r1", name: "admin", tags: ["alpha"] }]);
    expect(body.data.tags).toEqual(["alpha"]);
  });

  it("PUT /api/admin/users/:userId updates fields", async () => {
    const { router, userRepo } = setup();
    const ctx = makeCtx("PUT", "/api/admin/users/u1", { name: "renamed" });
    await router.dispatch(ctx);
    expect(userRepo.update).toHaveBeenCalledWith("u1", { name: "renamed" });
    expect(bodyOf(ctx).statusCode).toBe(200);
  });

  it("PUT /api/admin/users/:userId returns 404 for unknown id", async () => {
    const { router } = setup();
    const ctx = makeCtx("PUT", "/api/admin/users/missing", { name: "x" });
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(404);
  });

  it("DELETE /api/admin/users/:userId cascades user_roles before deleting user", async () => {
    const { router, userRepo, userRoleRepo } = setup();
    const ctx = makeCtx("DELETE", "/api/admin/users/u1");
    await router.dispatch(ctx);
    expect(userRoleRepo.deleteByUserId).toHaveBeenCalledWith("u1");
    expect(userRepo.delete).toHaveBeenCalledWith("u1");
    expect(bodyOf(ctx).statusCode).toBe(200);
    // Cascade order matters: cascade before delete so FK can't reject.
    const cascadeOrder = userRoleRepo.deleteByUserId.mock.invocationCallOrder[0];
    const deleteOrder = userRepo.delete.mock.invocationCallOrder[0];
    expect(cascadeOrder).toBeLessThan(deleteOrder);
  });

  it("DELETE /api/admin/users/:userId returns 404 when user is gone", async () => {
    const { router } = setup();
    const ctx = makeCtx("DELETE", "/api/admin/users/missing");
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(404);
  });

  it("PUT /api/admin/users/:userId/roles publishes user:roles_changed", async () => {
    const { router, userRoleRepo, eventBus } = setup();
    const ctx = makeCtx("PUT", "/api/admin/users/u1/roles", { role_ids: ["r1", "r2"] });
    await router.dispatch(ctx);
    expect(userRoleRepo.replaceUserRoles).toHaveBeenCalledWith("u1", ["r1", "r2"]);
    expect(eventBus.publish).toHaveBeenCalledWith({ type: "user:roles_changed", userId: "u1" });
  });

  it("PUT /api/admin/users/:userId/roles with omitted role_ids clears all roles", async () => {
    const { router, userRoleRepo } = setup();
    const ctx = makeCtx("PUT", "/api/admin/users/u1/roles", {});
    await router.dispatch(ctx);
    expect(userRoleRepo.replaceUserRoles).toHaveBeenCalledWith("u1", []);
  });

  it("PUT /api/admin/users/:userId/roles returns 404 for unknown user (no event published)", async () => {
    const { router, eventBus } = setup();
    const ctx = makeCtx("PUT", "/api/admin/users/missing/roles", { role_ids: ["r1"] });
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(404);
    expect(eventBus.publish).not.toHaveBeenCalled();
  });
});
