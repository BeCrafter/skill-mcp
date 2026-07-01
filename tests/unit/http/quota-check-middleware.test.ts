import { describe, it, expect, vi, beforeEach } from "vitest";
import { createQuotaCheck } from "@/http/middleware/quota-check.js";
import type { HttpContext } from "@/http/context.js";
import type { QuotaService, CheckResult, QuotaDimension } from "@/services/quota.service.js";

function makeRes() {
  const setHeaderCalls: Array<[string, string]> = [];
  const headers: Record<string, unknown> = {};
  let body = "";
  const res = {
    statusCode: 0,
    headersSent: false,
    writeHead: vi.fn((status: number, h?: Record<string, unknown>) => {
      res.statusCode = status;
      if (h) Object.assign(headers, h);
      res.headersSent = true;
    }),
    setHeader: vi.fn((name: string, value: string) => {
      setHeaderCalls.push([name, value]);
      headers[name] = value;
    }),
    write: vi.fn(),
    end: vi.fn((chunk?: string | Buffer) => { if (chunk) body += chunk.toString(); }),
    _body: () => body,
    _headers: () => headers,
    _setHeaderCalls: () => setHeaderCalls,
  };
  return res as never;
}

function makeCtx(method: string, url: string): HttpContext {
  const req = { headers: {} } as never;
  return {
    req, res: makeRes(),
    url, method, params: {}, query: new URLSearchParams(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    requestContext: { userId: "u1", tags: new Set(), isAuthenticated: true } as never,
  };
}

function makeQuotaService(result: CheckResult): { quotaService: QuotaService; check: ReturnType<typeof vi.fn> } {
  const check = vi.fn<(opts: { tenantId: string; dimension: QuotaDimension; increment?: number }) => CheckResult>().mockReturnValue(result);
  const quotaService = { check } as unknown as QuotaService;
  return { quotaService, check };
}

describe("createQuotaCheck (P1-13.5)", () => {
  describe("happy path", () => {
    it("calls next() and writes X-Quota-* headers when ok", async () => {
      const { quotaService } = makeQuotaService({
        ok: true, used: 10, limit: 1000, remaining: 990, source: "tier",
      });
      const mw = createQuotaCheck({ quotaService, dimension: "api_calls", scope: "gateway" });
      const ctx = makeCtx("POST", "/api/gateway/skills/foo");
      const next = vi.fn();
      await mw(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
      const headerCalls = (ctx.res as never as { _setHeaderCalls: () => Array<[string, string]> })._setHeaderCalls();
      const map = Object.fromEntries(headerCalls);
      expect(map["X-Quota-Limit"]).toBe("1000");
      expect(map["X-Quota-Remaining"]).toBe("990");
      expect(map["X-Quota-Source"]).toBe("tier");
    });

    it("always uses default tenantId", async () => {
      const { quotaService, check } = makeQuotaService({
        ok: true, used: 0, limit: 100, remaining: 100, source: "tier",
      });
      const mw = createQuotaCheck({ quotaService, dimension: "api_calls", scope: "gateway" });
      const ctx = makeCtx("GET", "/api/gateway/skills");
      await mw(ctx, vi.fn());
      expect(check).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "default" }));
    });

    it("respects a function-form increment so byte counts can be passed in", async () => {
      const { quotaService, check } = makeQuotaService({
        ok: true, used: 0, limit: 1024, remaining: 1024, source: "tier",
      });
      const mw = createQuotaCheck({
        quotaService, dimension: "storage_bytes", scope: "admin",
        increment: () => 512,
      });
      const ctx = makeCtx("POST", "/api/admin/skills");
      await mw(ctx, vi.fn());
      expect(check).toHaveBeenCalledWith(expect.objectContaining({ increment: 512 }));
    });
  });

  describe("denial path (429)", () => {
    it("writes 429 + Retry-After + JSON body when not ok", async () => {
      const { quotaService } = makeQuotaService({
        ok: false, used: 1000, limit: 1000, remaining: 0, source: "tier",
      });
      const mw = createQuotaCheck({ quotaService, dimension: "api_calls", scope: "gateway" });
      const ctx = makeCtx("POST", "/api/gateway/skills/foo");
      const next = vi.fn();
      await mw(ctx, next);
      expect(next).not.toHaveBeenCalled();
      const r = ctx.res as unknown as { statusCode: number; _body: () => string };
      expect(r.statusCode).toBe(429);
      const body = JSON.parse(r._body());
      expect(body).toEqual({
        success: false,
        error: "Quota exceeded",
        dimension: "api_calls",
        limit: 1000,
        used: 1000,
        retryAfterSec: 60,
      });
    });

    it("does not write a second response if headers were already sent", async () => {
      const { quotaService } = makeQuotaService({
        ok: false, used: 100, limit: 100, remaining: 0, source: "tier",
      });
      const mw = createQuotaCheck({ quotaService, dimension: "api_calls", scope: "gateway" });
      const ctx = makeCtx("GET", "/api/gateway/skills");
      // Simulate headers already sent (e.g. earlier middleware streamed).
      (ctx.res as unknown as { headersSent: boolean }).headersSent = true;
      const next = vi.fn();
      await mw(ctx, next);
      const r = ctx.res as unknown as { statusCode: number; end: { mock: { calls: unknown[][] } } };
      // statusCode never written — middleware bailed early.
      expect(r.statusCode).toBe(0);
      expect(r.end.mock.calls).toHaveLength(0);
    });
  });

  describe("skip predicate", () => {
    it("default skip lets /health bypass the check", async () => {
      const { quotaService, check } = makeQuotaService({
        ok: false, used: 99999, limit: 1, remaining: 0, source: "tier",
      });
      const mw = createQuotaCheck({ quotaService, dimension: "api_calls", scope: "gateway" });
      const ctx = makeCtx("GET", "/api/gateway/health");
      const next = vi.fn();
      await mw(ctx, next);
      expect(check).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("custom skip predicate is honored", async () => {
      const { quotaService, check } = makeQuotaService({
        ok: false, used: 99999, limit: 1, remaining: 0, source: "tier",
      });
      const mw = createQuotaCheck({
        quotaService, dimension: "api_calls", scope: "gateway",
        skip: () => true,
      });
      const ctx = makeCtx("GET", "/anywhere");
      const next = vi.fn();
      await mw(ctx, next);
      expect(check).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe("source: unknown (fail-open)", () => {
    it("when limit is Infinity, headers are not written", async () => {
      const { quotaService } = makeQuotaService({
        ok: true, used: 0,
        limit: Number.POSITIVE_INFINITY,
        remaining: Number.POSITIVE_INFINITY,
        source: "unknown",
      });
      const mw = createQuotaCheck({ quotaService, dimension: "api_calls", scope: "gateway" });
      const ctx = makeCtx("GET", "/api/gateway/skills");
      const next = vi.fn();
      await mw(ctx, next);
      expect(next).toHaveBeenCalled();
      const headerCalls = (ctx.res as never as { _setHeaderCalls: () => Array<[string, string]> })._setHeaderCalls();
      const limitHeader = headerCalls.find(([n]) => n === "X-Quota-Limit");
      expect(limitHeader).toBeUndefined();
    });
  });
});
