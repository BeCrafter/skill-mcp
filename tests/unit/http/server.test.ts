import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { createRequestHandler } from "@/http/server.js";
import { Router } from "@/http/router.js";
import type { AppConfig } from "@/config/schema.js";

// Minimal fake response that captures status / body / end-state, mimicking
// the surface area of node:http ServerResponse that createRequestHandler
// touches (writeHead / end / setHeader / statusCode / headersSent).
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
  auth: {},
  security: { enableInjectionScan: true, hstsEnabled: false },
} as unknown as AppConfig;

describe("createRequestHandler", () => {
  let adminRouter: Router;
  let gatewayRouter: Router;

  beforeEach(() => {
    adminRouter = new Router();
    gatewayRouter = new Router();
  });

  it("/api/health returns 200 ok", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/health"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).status).toBe("ok");
    // Baseline security headers always present.
    expect(out.headers["x-content-type-options"]).toBe("nosniff");
    expect(out.headers["referrer-policy"]).toBe("no-referrer");
    // T-737 — HSTS off by default (no TLS terminator assumed).
    expect(out.headers["strict-transport-security"]).toBeUndefined();
  });

  it("emits HSTS header only when security.hstsEnabled=true (T-737)", async () => {
    const cfg = { ...baseConfig, security: { enableInjectionScan: true, hstsEnabled: true } } as unknown as AppConfig;
    const handler = createRequestHandler({
      appConfig: cfg, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/health"), res);
    expect(capture().headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });

  it("delegates /mcp/* to mcpHandler when set", async () => {
    const mcpHandler = vi.fn(async (_req, res) => { res.writeHead(204); res.end(); });
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("POST", "/mcp"), res);
    expect(mcpHandler).toHaveBeenCalledOnce();
    expect(capture().statusCode).toBe(204);
  });

  it("returns 403 on /mcp when in cloud-only mode without mcpHandler", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: true,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/mcp"), res);
    expect(capture().statusCode).toBe(403);
  });

  it("returns 404 on /api/admin/* in MCP-only mode (route table not consulted)", async () => {
    const cfg = { ...baseConfig, transport: { mcpOnlyMode: true } } as AppConfig;
    adminRouter.get("/api/admin/skills", async (ctx) => { ctx.res.writeHead(200); ctx.res.end("[]"); });
    const handler = createRequestHandler({
      appConfig: cfg, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/admin/skills"), res);
    expect(capture().statusCode).toBe(404);
  });

  it("returns 404 for unknown route", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/totally/unknown"), res);
    expect(capture().statusCode).toBe(404);
  });

  // T-707 — /metrics used to be anonymous; default-secure now requires admin
  // tag bearer. SKILL_MCP_METRICS_AUTH_OPTIONAL=true (mapped to
  // appConfig.auth.metricsAuthOptional) restores legacy behavior for trusted
  // intra-cluster Prometheus scrapers.
  it("/metrics rejects anonymous request when metricsAuthOptional=false", async () => {
    const cfg = {
      ...baseConfig,
      auth: { metricsAuthOptional: false },
    } as unknown as AppConfig;
    const handler = createRequestHandler({
      appConfig: cfg, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
      // Provide minimal stubs so admin-auth doesn't 500 on missing repos.
      userRepo: { findByToken: () => null } as never,
      userRoleRepo: { listRolesByUserId: () => [] } as never,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/metrics"), res);
    expect(capture().statusCode).toBe(401);
  });

  it("/metrics is anonymous when metricsAuthOptional=true (legacy)", async () => {
    const cfg = {
      ...baseConfig,
      auth: { metricsAuthOptional: true },
    } as unknown as AppConfig;
    const handler = createRequestHandler({
      appConfig: cfg, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/metrics"), res);
    expect(capture().statusCode).toBe(200);
  });

  // P0-2 — OpenAPI spec + Swagger UI mounted on the server (no auth required).
  it("GET /api/v1/openapi.json returns the OpenAPI 3.1 document anonymously", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/v1/openapi.json"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    const doc = JSON.parse(out.body);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/admin/skills/{slug}/publish"]).toBeTruthy();
  });

  it("GET /api/openapi.json (unprefixed) also serves the spec", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/openapi.json"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).openapi).toBe("3.1.0");
  });

  it("GET /api/v1/docs serves the Swagger UI HTML page", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/v1/docs"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(out.body).toMatch(/swagger-ui-bundle\.js/);
    expect(out.body).toContain("/api/v1/openapi.json");
  });

  it("/api/gateway/health bypasses gateway auth (used by LB probes)", async () => {
    gatewayRouter.get("/api/gateway/health", async (ctx) => {
      ctx.res.writeHead(200, { "Content-Type": "application/json" });
      ctx.res.end(JSON.stringify({ ok: true }));
    });
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/gateway/health"), res);
    expect(capture().statusCode).toBe(200);
    expect(JSON.parse(capture().body).ok).toBe(true);
  });
});
