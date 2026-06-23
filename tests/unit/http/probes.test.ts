import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { createRequestHandler } from "@/http/server.js";
import { Router } from "@/http/router.js";
import { checkLiveness, checkReadiness } from "@/http/probes.js";
import type { AppConfig } from "@/config/schema.js";
import type { SkillRepository } from "@/db/repositories/skill.repository.js";

function makeRes() {
  let statusCode = 200;
  let body = "";
  let headersSent = false;
  const headers: Record<string, string | number> = {};
  return {
    res: {
      get statusCode() { return statusCode; },
      set statusCode(v: number) { statusCode = v; },
      get headersSent() { return headersSent; },
      writeHead(code: number, h?: Record<string, string | number>) {
        statusCode = code; headersSent = true;
        if (h) Object.assign(headers, h);
      },
      setHeader(name: string, value: string | number) { headers[name.toLowerCase()] = value; },
      end(payload?: string) { if (payload) body = payload; headersSent = true; },
    } as never,
    capture: () => ({ statusCode, body, headers }),
  };
}

function makeReq(method: string, url: string) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
  req.method = method; req.url = url; req.headers = { host: "localhost" };
  return req as never;
}

const baseConfig = {
  deployment: { mode: "standalone" as const },
  transport: { mcpOnlyMode: false },
  auth: {},
  security: { enableInjectionScan: true, hstsEnabled: false },
} as unknown as AppConfig;

describe("checkLiveness (P0-7)", () => {
  it("returns status=ok with timestamp", () => {
    const r = checkLiveness();
    expect(r.status).toBe("ok");
    expect(r.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not throw when called repeatedly (no shared state)", () => {
    expect(() => { checkLiveness(); checkLiveness(); checkLiveness(); }).not.toThrow();
  });
});

describe("checkReadiness (P0-7)", () => {
  it("returns status=ok when skillRepo.count() succeeds", async () => {
    const skillRepo = { count: async () => 0 } as unknown as SkillRepository;
    const r = await checkReadiness({ skillRepo });
    expect(r.status).toBe("ok");
    expect(r.checks.db.ok).toBe(true);
    expect(r.checks.db.error).toBeUndefined();
    expect(typeof r.checks.db.latencyMs).toBe("number");
  });

  it("returns status=not_ready when DB throws", async () => {
    const skillRepo = { count: () => { throw new Error("database is locked"); } } as unknown as SkillRepository;
    const r = await checkReadiness({ skillRepo });
    expect(r.status).toBe("not_ready");
    expect(r.checks.db.ok).toBe(false);
    expect(r.checks.db.error).toContain("database is locked");
  });

  it("returns status=not_ready when skillRepo is missing (fail closed)", async () => {
    const r = await checkReadiness({});
    expect(r.status).toBe("not_ready");
    expect(r.checks.db.ok).toBe(false);
    expect(r.checks.db.error).toBe("skillRepo not configured");
  });
});

describe("HTTP probe endpoints (P0-7)", () => {
  let adminRouter: Router;
  let gatewayRouter: Router;
  beforeEach(() => {
    adminRouter = new Router();
    gatewayRouter = new Router();
  });

  it("/api/v1/livez returns 200 with status=ok (no DB call)", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
      // intentionally no skillRepo — livez must not depend on it
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/v1/livez"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).status).toBe("ok");
    expect(out.headers["deprecation"]).toBeUndefined();
  });

  it("/api/v1/readyz returns 200 when DB is reachable", async () => {
    const skillRepo = { count: () => 0 } as unknown as SkillRepository;
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter, skillRepo,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/v1/readyz"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body);
    expect(body.status).toBe("ok");
    expect(body.checks.db.ok).toBe(true);
  });

  it("/api/v1/readyz returns 503 when DB throws", async () => {
    const skillRepo = { count: () => { throw new Error("disk I/O"); } } as unknown as SkillRepository;
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter, skillRepo,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/v1/readyz"), res);
    const out = capture();
    expect(out.statusCode).toBe(503);
    const body = JSON.parse(out.body);
    expect(body.status).toBe("not_ready");
    expect(body.checks.db.ok).toBe(false);
    expect(body.checks.db.error).toContain("disk I/O");
  });

  it("/api/v1/readyz returns 503 when skillRepo is not wired", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/v1/readyz"), res);
    expect(capture().statusCode).toBe(503);
  });

  it("/api/livez (legacy unprefixed) also works (no deprecation header — new endpoint)", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/livez"), res);
    const out = capture();
    // /api/livez does not match the /api/admin/* or /api/gateway/* legacy
    // alias rules, so it dispatches directly without deprecation headers.
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).status).toBe("ok");
  });

  it("legacy /api/health still returns 200 with shape preserved", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, isCloudServiceOnlyMode: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/health"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).status).toBe("ok");
    // P0-1 — legacy /api/health emits deprecation header pointing at livez
    expect(out.headers["deprecation"]).toBe("true");
    expect(out.headers["link"]).toContain("/api/v1/livez");
  });
});
