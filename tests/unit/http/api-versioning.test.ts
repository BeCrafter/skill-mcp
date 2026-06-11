import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { createRequestHandler } from "@/http/server.js";
import { Router } from "@/http/router.js";
import type { AppConfig } from "@/config/schema.js";

// Same minimal request/response stubs used in server.test.ts. P0-1 cares about
// the URL-normalization layer in createRequestHandler, so we don't need real
// repositories or auth here — adminAuthOptional=true skips the bearer check
// and lets us assert dispatch + deprecation header behavior in isolation.
function makeRes() {
  let statusCode = 200;
  let body = "";
  let ended = false;
  let headersSent = false;
  const headers: Record<string, string | number> = {};
  return {
    res: {
      get statusCode() { return statusCode; },
      set statusCode(v: number) { statusCode = v; },
      get headersSent() { return headersSent; },
      writeHead(code: number, h?: Record<string, string | number>) {
        statusCode = code;
        headersSent = true;
        if (h) Object.assign(headers, h);
      },
      setHeader(name: string, value: string | number) { headers[name.toLowerCase()] = value; },
      end(payload?: string) { if (payload) body = payload; ended = true; headersSent = true; },
    } as never,
    capture: () => ({ statusCode, body, ended, headers }),
  };
}

function makeReq(method: string, url: string) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost" };
  return req as never;
}

const baseConfig = {
  deployment: { mode: "standalone" as const },
  transport: { mcpOnlyMode: false },
  auth: { adminAuthOptional: true },
  security: { enableInjectionScan: true, hstsEnabled: false },
} as unknown as AppConfig;

// Gateway auth refuses to dispatch without a working userRepo + userRoleRepo
// pair, so for gateway dispatch tests we stub a user that is always authenticated.
// All P0-1 cares about is URL normalization + deprecation headers — the auth
// shape is incidental.
const fakeGatewayDeps = {
  userRepo: {
    findByToken: async () => ({ id: "user-1", username: "tester", status: "active" }),
  } as never,
  userRoleRepo: {
    getAggregatedTagsByUserId: async () => ["public:read"],
  } as never,
};
function authedReq(method: string, url: string) {
  const req = makeReq(method, url);
  (req as unknown as { headers: Record<string, string> }).headers["authorization"] = "Bearer fake-token";
  return req;
}

describe("API versioning (P0-1)", () => {
  let adminRouter: Router;
  let gatewayRouter: Router;

  beforeEach(() => {
    adminRouter = new Router();
    gatewayRouter = new Router();
    adminRouter.get("/api/admin/skills", async (ctx) => {
      ctx.res.writeHead(200, { "Content-Type": "application/json" });
      ctx.res.end(JSON.stringify({ ok: true, route: "admin-skills" }));
    });
    adminRouter.get("/api/admin/skills/:slug", async (ctx) => {
      ctx.res.writeHead(200, { "Content-Type": "application/json" });
      ctx.res.end(JSON.stringify({ slug: ctx.params.slug }));
    });
    gatewayRouter.get("/api/gateway/skills", async (ctx) => {
      ctx.res.writeHead(200, { "Content-Type": "application/json" });
      ctx.res.end(JSON.stringify({ ok: true, route: "gateway-skills" }));
    });
    gatewayRouter.get("/api/gateway/health", async (ctx) => {
      ctx.res.writeHead(200, { "Content-Type": "application/json" });
      ctx.res.end(JSON.stringify({ ok: true }));
    });
  });

  it("/api/v1/admin/skills dispatches to admin router (canonical path)", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/v1/admin/skills"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).route).toBe("admin-skills");
    // Canonical paths MUST NOT emit deprecation headers.
    expect(out.headers["deprecation"]).toBeUndefined();
    expect(out.headers["sunset"]).toBeUndefined();
  });

  it("/api/v1/admin/skills/:slug preserves route params after normalization", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/v1/admin/skills/my-skill"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).slug).toBe("my-skill");
  });

  it("/api/v1/gateway/skills dispatches to gateway router", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
      ...fakeGatewayDeps,
    });
    const { res, capture } = makeRes();
    await handler(authedReq("GET", "/api/v1/gateway/skills"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).route).toBe("gateway-skills");
    expect(out.headers["deprecation"]).toBeUndefined();
  });

  it("/api/v1/gateway/health bypasses gateway auth (LB probe parity)", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/v1/gateway/health"), res);
    expect(capture().statusCode).toBe(200);
  });

  it("/api/v1/health returns 200 ok", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/v1/health"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).status).toBe("ok");
    expect(out.headers["deprecation"]).toBeUndefined();
  });

  it("legacy /api/admin/* still works and emits Deprecation + Sunset headers (RFC 8594)", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/admin/skills"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(out.headers["deprecation"]).toBe("true");
    expect(out.headers["sunset"]).toBe("Sat, 28 Nov 2026 00:00:00 GMT");
    expect(out.headers["link"]).toContain('/api/v1/admin/skills');
    expect(out.headers["link"]).toContain('rel="successor-version"');
  });

  it("legacy /api/gateway/* emits Deprecation + Sunset headers", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
      ...fakeGatewayDeps,
    });
    const { res, capture } = makeRes();
    await handler(authedReq("GET", "/api/gateway/skills"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(out.headers["deprecation"]).toBe("true");
    expect(out.headers["link"]).toContain("/api/v1/gateway/skills");
  });

  it("legacy /api/health emits Deprecation pointing at /api/v1/livez (P0-7 rename)", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/health"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(out.headers["deprecation"]).toBe("true");
    expect(out.headers["link"]).toContain("/api/v1/livez");
  });

  it("/api/v2/* returns 404 (only v1 is recognized)", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/v2/admin/skills"), res);
    expect(capture().statusCode).toBe(404);
  });

  it("/api/v1/unknown returns 404", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/v1/unknown/path"), res);
    expect(capture().statusCode).toBe(404);
  });
});
