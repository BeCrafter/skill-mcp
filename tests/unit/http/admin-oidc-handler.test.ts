import { describe, it, expect, vi } from "vitest";
import { Router } from "@/http/router.js";
import { errorMap } from "@/http/middleware/error-map.js";
import { registerAdminOidcRoutes } from "@/http/handlers/admin/oidc.handler.js";
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

function makeCtx(method: string, url: string, body?: unknown, query?: Record<string, string>): HttpContext {
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
    url, method, params: {},
    query: new URLSearchParams(query ?? {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  };
}

function bodyOf(ctx: HttpContext) {
  const r = ctx.res as unknown as { statusCode: number; _body: () => string };
  return { statusCode: r.statusCode, body: r._body() ? JSON.parse(r._body()) : undefined };
}

function setup() {
  const oidcGroupRoleMapRepo = {
    findAllByTenant: vi.fn(async (tenantId: string) => [
      { id: "m1", tenantId, groupName: "engineering", roleId: "r-fe", createdAt: 1, updatedAt: 1 },
      { id: "m2", tenantId, groupName: "engineering", roleId: "r-be", createdAt: 1, updatedAt: 1 },
      { id: "m3", tenantId, groupName: "ops", roleId: "r-ops", createdAt: 1, updatedAt: 1 },
    ]),
    create: vi.fn(async (input: { tenantId: string; groupName: string; roleId: string }) => ({
      id: "m-new", ...input, createdAt: 2, updatedAt: 2,
    })),
    replaceForGroup: vi.fn(async () => undefined),
    deleteById: vi.fn(async (id: string) => id === "m1"),
  };
  const oidcIdentityRepo = {
    findByUserId: vi.fn(async (userId: string) =>
      userId === "u1"
        ? [{ id: "i1", tenantId: "default", issuer: "https://idp", subject: "alice", userId, createdAt: 1, lastSeenAt: 2 }]
        : []
    ),
  };
  const router = new Router();
  router.use(errorMap());
  registerAdminOidcRoutes(router, {
    oidcGroupRoleMapRepo, oidcIdentityRepo,
  } as unknown as AppDependencies);
  return { router, oidcGroupRoleMapRepo, oidcIdentityRepo };
}

describe("registerAdminOidcRoutes", () => {
  it("does NOT register routes when repos are missing", () => {
    const router = new Router();
    registerAdminOidcRoutes(router, {} as unknown as AppDependencies);
    expect(router.match("GET", "/api/admin/oidc/groups-mapping")).toBeNull();
    expect(router.match("GET", "/api/admin/oidc/identities")).toBeNull();
  });

  it("GET /api/admin/oidc/groups-mapping returns rows for default tenant", async () => {
    const { router, oidcGroupRoleMapRepo } = setup();
    const ctx = makeCtx("GET", "/api/admin/oidc/groups-mapping");
    await router.dispatch(ctx);
    expect(oidcGroupRoleMapRepo.findAllByTenant).toHaveBeenCalledWith("default");
    const out = bodyOf(ctx);
    expect(out.statusCode).toBe(200);
    expect(out.body.success).toBe(true);
    expect(out.body.data.length).toBe(3);
  });

  it("GET /api/admin/oidc/groups-mapping respects ?tenantId=", async () => {
    const { router, oidcGroupRoleMapRepo } = setup();
    const ctx = makeCtx("GET", "/api/admin/oidc/groups-mapping", undefined, { tenantId: "acme" });
    await router.dispatch(ctx);
    expect(oidcGroupRoleMapRepo.findAllByTenant).toHaveBeenCalledWith("acme");
    expect(bodyOf(ctx).statusCode).toBe(200);
  });

  it("POST rejects missing groupName", async () => {
    const { router } = setup();
    const ctx = makeCtx("POST", "/api/admin/oidc/groups-mapping", { roleId: "r-fe" });
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(400);
  });

  it("POST rejects missing roleId", async () => {
    const { router } = setup();
    const ctx = makeCtx("POST", "/api/admin/oidc/groups-mapping", { groupName: "g" });
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(400);
  });

  it("POST creates a mapping row and returns 201", async () => {
    const { router, oidcGroupRoleMapRepo } = setup();
    const ctx = makeCtx("POST", "/api/admin/oidc/groups-mapping", {
      groupName: "engineering", roleId: "r-fe",
    });
    await router.dispatch(ctx);
    expect(oidcGroupRoleMapRepo.create).toHaveBeenCalledWith({
      tenantId: "default", groupName: "engineering", roleId: "r-fe",
    });
    const out = bodyOf(ctx);
    expect(out.statusCode).toBe(201);
    expect(out.body.success).toBe(true);
    expect(out.body.data.groupName).toBe("engineering");
  });

  it("POST honours tenantId in body", async () => {
    const { router, oidcGroupRoleMapRepo } = setup();
    const ctx = makeCtx("POST", "/api/admin/oidc/groups-mapping", {
      groupName: "engineering", roleId: "r-fe", tenantId: "acme",
    });
    await router.dispatch(ctx);
    expect(oidcGroupRoleMapRepo.create).toHaveBeenCalledWith({
      tenantId: "acme", groupName: "engineering", roleId: "r-fe",
    });
  });

  it("PUT rejects missing groupName", async () => {
    const { router } = setup();
    const ctx = makeCtx("PUT", "/api/admin/oidc/groups-mapping", { roleIds: ["r-fe"] });
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(400);
  });

  it("PUT rejects non-array roleIds", async () => {
    const { router } = setup();
    const ctx = makeCtx("PUT", "/api/admin/oidc/groups-mapping", {
      groupName: "engineering", roleIds: "r-fe",
    });
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(400);
  });

  it("PUT calls replaceForGroup with filtered roleIds and returns the updated rows for that group", async () => {
    const { router, oidcGroupRoleMapRepo } = setup();
    const ctx = makeCtx("PUT", "/api/admin/oidc/groups-mapping", {
      groupName: "engineering", roleIds: ["r-fe", "r-be", "", null],
    });
    await router.dispatch(ctx);
    expect(oidcGroupRoleMapRepo.replaceForGroup).toHaveBeenCalledWith(
      "default", "engineering", ["r-fe", "r-be"],
    );
    const out = bodyOf(ctx);
    expect(out.statusCode).toBe(200);
    // Only engineering rows are returned (mock returns 3 rows total, 2 match groupName).
    expect(out.body.data.length).toBe(2);
    expect(out.body.data.every((r: { groupName: string }) => r.groupName === "engineering")).toBe(true);
  });

  it("DELETE /:id returns 200 when a row was removed", async () => {
    const { router, oidcGroupRoleMapRepo } = setup();
    const ctx = makeCtx("DELETE", "/api/admin/oidc/groups-mapping/m1");
    await router.dispatch(ctx);
    expect(oidcGroupRoleMapRepo.deleteById).toHaveBeenCalledWith("m1");
    expect(bodyOf(ctx).statusCode).toBe(200);
  });

  it("DELETE /:id returns 404 when no row was removed", async () => {
    const { router } = setup();
    const ctx = makeCtx("DELETE", "/api/admin/oidc/groups-mapping/missing");
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(404);
  });

  it("GET /api/admin/oidc/identities requires userId", async () => {
    const { router } = setup();
    const ctx = makeCtx("GET", "/api/admin/oidc/identities");
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(400);
  });

  it("GET /api/admin/oidc/identities returns rows for matching userId", async () => {
    const { router, oidcIdentityRepo } = setup();
    const ctx = makeCtx("GET", "/api/admin/oidc/identities", undefined, { userId: "u1" });
    await router.dispatch(ctx);
    expect(oidcIdentityRepo.findByUserId).toHaveBeenCalledWith("u1");
    const out = bodyOf(ctx);
    expect(out.statusCode).toBe(200);
    expect(out.body.data.length).toBe(1);
    expect(out.body.data[0].subject).toBe("alice");
  });

  it("GET /api/admin/oidc/identities returns empty data for unknown user", async () => {
    const { router } = setup();
    const ctx = makeCtx("GET", "/api/admin/oidc/identities", undefined, { userId: "ghost" });
    await router.dispatch(ctx);
    const out = bodyOf(ctx);
    expect(out.statusCode).toBe(200);
    expect(out.body.data).toEqual([]);
  });
});
