import { describe, it, expect, vi } from "vitest";
import { Router } from "@/http/router.js";
import { errorMap } from "@/http/middleware/error-map.js";
import { registerAdminRoleRoutes } from "@/http/handlers/admin/roles.handler.js";
import type { HttpContext } from "@/http/context.js";
import type { AppDependencies } from "@/app-dependencies.js";

function makeRes() {
  let body = "";
  const res = {
    statusCode: 0,
    writeHead: vi.fn((status: number) => { res.statusCode = status; }),
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
    requestContext: { userId: "admin-1", userType: "superadmin" } as never,
  };
}

function bodyOf(ctx: HttpContext) {
  const r = ctx.res as unknown as { statusCode: number; _body: () => string };
  return { statusCode: r.statusCode, body: r._body() ? JSON.parse(r._body()) : undefined };
}

function setup() {
  const roleRepo = {
    findAll: vi.fn().mockResolvedValue([{ id: "r1", name: "alpha", tags: ["x"] }]),
    findById: vi.fn(async (id: string) => (id === "r1" ? { id, name: "alpha", tags: ["x"] } : null)),
    create: vi.fn(async ({ name, tags }: { name: string; tags: string[] }) => ({ id: "r-new", name, tags })),
    update: vi.fn(async (id: string, fields: Record<string, unknown>) => (id === "r1" ? { id, ...fields } : null)),
    delete: vi.fn(async (id: string) => id === "r1"),
  };
  const userRoleRepo = {
    findUserIdsByRoleId: vi.fn().mockResolvedValue(["u1", "u2"]),
    deleteByRoleId: vi.fn().mockResolvedValue(undefined),
  };
  const eventBus = { publish: vi.fn() };
  const router = new Router();
  router.use(errorMap());
  registerAdminRoleRoutes(router, {
    roleRepo, userRoleRepo, userRepo: {} as never, eventBus,
  } as unknown as AppDependencies);
  return { router, roleRepo, userRoleRepo, eventBus };
}

describe("registerAdminRoleRoutes — coverage extension", () => {
  it("does NOT register routes when dependencies are missing", () => {
    const router = new Router();
    registerAdminRoleRoutes(router, { roleRepo: undefined } as unknown as AppDependencies);
    expect(router.match("GET", "/api/admin/roles")).toBeNull();
  });

  it("GET /api/admin/roles lists roles", async () => {
    const { router, roleRepo } = setup();
    const ctx = makeCtx("GET", "/api/admin/roles");
    await router.dispatch(ctx);
    expect(roleRepo.findAll).toHaveBeenCalled();
    expect(bodyOf(ctx).statusCode).toBe(200);
  });

  it("POST /api/admin/roles requires name + tags", async () => {
    const { router } = setup();
    const ctx = makeCtx("POST", "/api/admin/roles", { name: "no-tags" });
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(400);
  });

  it("POST /api/admin/roles creates and returns 201", async () => {
    const { router, roleRepo } = setup();
    const ctx = makeCtx("POST", "/api/admin/roles", { name: "beta", tags: ["t1"], description: "d" });
    await router.dispatch(ctx);
    expect(roleRepo.create).toHaveBeenCalledWith({ name: "beta", tags: ["t1"], description: "d" });
    expect(bodyOf(ctx).statusCode).toBe(201);
  });

  it("GET /api/admin/roles/:roleId 404 for unknown id", async () => {
    const { router } = setup();
    const ctx = makeCtx("GET", "/api/admin/roles/missing");
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(404);
  });

  it("GET /api/admin/roles/:roleId returns role", async () => {
    const { router } = setup();
    const ctx = makeCtx("GET", "/api/admin/roles/r1");
    await router.dispatch(ctx);
    const out = bodyOf(ctx);
    expect(out.statusCode).toBe(200);
    expect((out.body as { data: { id: string } }).data.id).toBe("r1");
  });

  it("PUT /api/admin/roles/:roleId publishes role:updated with affectedUserIds", async () => {
    const { router, eventBus, roleRepo } = setup();
    const ctx = makeCtx("PUT", "/api/admin/roles/r1", { tags: ["new"] });
    await router.dispatch(ctx);
    expect(roleRepo.update).toHaveBeenCalledWith("r1", { tags: ["new"] });
    expect(eventBus.publish).toHaveBeenCalledWith({
      type: "role:updated", roleId: "r1", affectedUserIds: ["u1", "u2"],
    });
  });

  it("PUT /api/admin/roles/:roleId 404 unknown id (no publish)", async () => {
    const { router, eventBus } = setup();
    const ctx = makeCtx("PUT", "/api/admin/roles/missing", { name: "x" });
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(404);
    expect(eventBus.publish).not.toHaveBeenCalled();
  });
});
