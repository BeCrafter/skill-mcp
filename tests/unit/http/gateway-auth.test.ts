import { describe, it, expect, vi } from "vitest";
import { enforceGatewayAuth } from "@/http/middleware/gateway-auth.js";
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
    url: "/api/gateway/skills",
    method: "GET",
    params: {},
    query: new URLSearchParams(),
    logger: noopLogger,
  };
}

function makeRepos(opts: {
  user?: { id: string; status: string } | null;
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

describe("enforceGatewayAuth", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const ctx = makeCtx();
    const { userRepo, userRoleRepo } = makeRepos();
    const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo });
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(401);
  });

  it("returns 401 when Authorization is not Bearer scheme", async () => {
    const ctx = makeCtx("Basic abc");
    const { userRepo, userRoleRepo } = makeRepos();
    const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo });
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(401);
  });

  it("returns 401 when token is unknown", async () => {
    const ctx = makeCtx("Bearer wrong-token");
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo });
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(401);
    const body = (ctx.res.end as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body).toContain("Invalid or expired token");
  });

  it("returns 401 when user is not active", async () => {
    const ctx = makeCtx("Bearer some-token");
    const { userRepo, userRoleRepo } = makeRepos({ user: { id: "u1", status: "disabled" } });
    const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo });
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(401);
  });

  it("returns RequestContext when token resolves to active user", async () => {
    const ctx = makeCtx("Bearer good-token");
    const { userRepo, userRoleRepo } = makeRepos({
      user: { id: "u1", status: "active" },
      tags: ["frontend", "data"],
    });
    const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo });
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("u1");
    expect(result!.isAuthenticated).toBe(true);
    expect([...result!.tags]).toEqual(["frontend", "data"]);
    expect(ctx.res.writeHead).not.toHaveBeenCalled();
  });

  it("returns 500 when userRepo is missing", async () => {
    const ctx = makeCtx("Bearer good-token");
    const result = await enforceGatewayAuth(ctx, {});
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(500);
  });

  it("uses x-session-id header when provided", async () => {
    const ctx = makeCtx("Bearer good-token");
    (ctx.req.headers as Record<string, string>)["x-session-id"] = "session-abc";
    const { userRepo, userRoleRepo } = makeRepos({
      user: { id: "u1", status: "active" },
    });
    const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo });
    expect(result!.sessionId).toBe("session-abc");
  });
});
