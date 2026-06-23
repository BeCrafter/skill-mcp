import { describe, it, expect, vi } from "vitest";
import { enforceAdminAuth } from "@/http/middleware/admin-auth.js";
import type { HttpContext } from "@/http/context.js";

const noopLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;

function makeRes() {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
    statusCode: 0,
  } as never;
}

function makeCtx(authHeader?: string): HttpContext {
  const res = makeRes();
  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
  } as never;
  return {
    req,
    res,
    url: "/api/admin/skills",
    method: "POST",
    params: {},
    query: new URLSearchParams(),
    logger: noopLogger,
  };
}

function makeRepos(opts: {
  user?: { id: string; status: string; userType?: string } | null;
  tags?: string[];
} = {}) {
  return {
    userRepo: {
      findByToken: vi.fn(async () => opts.user ?? null),
    } as never,
    userRoleRepo: {
      getAggregatedTagsByUserId: vi.fn(async () => opts.tags ?? []),
    } as never,
  };
}

describe("enforceAdminAuth", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const ctx = makeCtx();
    const { userRepo, userRoleRepo } = makeRepos();
    const result = await enforceAdminAuth(ctx, { userRepo, userRoleRepo });
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(401);
  });

  it("returns 401 when token is unknown", async () => {
    const ctx = makeCtx("Bearer wrong-token");
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    const result = await enforceAdminAuth(ctx, { userRepo, userRoleRepo });
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(401);
  });

  it("returns 403 when authenticated user lacks admin userType", async () => {
    const ctx = makeCtx("Bearer plain-user-token");
    const { userRepo, userRoleRepo } = makeRepos({
      user: { id: "u1", status: "active", userType: "user" },
      tags: ["frontend", "data"],
    });
    const result = await enforceAdminAuth(ctx, { userRepo, userRoleRepo });
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(403);
    const body = (ctx.res.end as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body).toContain("Admin privilege required");
  });

  it("returns RequestContext when authenticated user has userType=admin", async () => {
    const ctx = makeCtx("Bearer admin-token");
    const { userRepo, userRoleRepo } = makeRepos({
      user: { id: "admin-1", status: "active", userType: "admin" },
      tags: ["ops"],
    });
    const result = await enforceAdminAuth(ctx, { userRepo, userRoleRepo });
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("admin-1");
    expect(result!.isAuthenticated).toBe(true);
    expect(result!.userType).toBe("admin");
    expect(ctx.res.writeHead).not.toHaveBeenCalled();
  });

  it("returns RequestContext when authenticated user has userType=superadmin", async () => {
    const ctx = makeCtx("Bearer superadmin-token");
    const { userRepo, userRoleRepo } = makeRepos({
      user: { id: "sa-1", status: "active", userType: "superadmin" },
      tags: ["ops"],
    });
    const result = await enforceAdminAuth(ctx, { userRepo, userRoleRepo });
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("sa-1");
    expect(result!.userType).toBe("superadmin");
    expect(ctx.res.writeHead).not.toHaveBeenCalled();
  });

  it("returns 500 when repos missing", async () => {
    const ctx = makeCtx("Bearer something");
    const result = await enforceAdminAuth(ctx, {});
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(500);
  });

  it("uses x-session-id header when provided", async () => {
    const ctx = makeCtx("Bearer admin-token");
    (ctx.req.headers as Record<string, string>)["x-session-id"] = "sess-xyz";
    const { userRepo, userRoleRepo } = makeRepos({
      user: { id: "admin-1", status: "active", userType: "admin" },
      tags: [],
    });
    const result = await enforceAdminAuth(ctx, { userRepo, userRoleRepo });
    expect(result!.sessionId).toBe("sess-xyz");
  });
});
