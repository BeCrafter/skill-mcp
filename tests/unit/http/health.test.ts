import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { createRequestHandler } from "@/http/server.js";
import { Router } from "@/http/router.js";
import type { AppConfig } from "@/config/schema.js";

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
  deployment: { mcpOnly: false, apiOnly: false },
  auth: {},
  security: { enableInjectionScan: true, hstsEnabled: false },
} as unknown as AppConfig;

describe("HTTP health endpoint", () => {
  let adminRouter: Router;
  let gatewayRouter: Router;
  beforeEach(() => {
    adminRouter = new Router();
    gatewayRouter = new Router();
  });

  it("/api/health returns 200 with status=ok", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, mcpOnly: false, apiOnly: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/health"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).status).toBe("ok");
    expect(JSON.parse(out.body).timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("/api/v1/health returns 200 (canonical)", async () => {
    const handler = createRequestHandler({
      appConfig: baseConfig, mcpHandler: null, mcpOnly: false, apiOnly: false,
      adminRouter, gatewayRouter,
    });
    const { res, capture } = makeRes();
    await handler(makeReq("GET", "/api/v1/health"), res);
    const out = capture();
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).status).toBe("ok");
  });
});
