import { describe, it, expect, vi, beforeEach } from "vitest";
import { Router } from "@/http/router.js";
import { errorMap } from "@/http/middleware/error-map.js";
import { registerAdminQuotaRoutes } from "@/http/handlers/admin/quotas.handler.js";
import type { HttpContext } from "@/http/context.js";
import type { AppDependencies } from "@/app-dependencies.js";
import type {
  TenantQuotaRepository,
  TenantQuotaEntity,
  QuotaOverrideEntity,
} from "@/db/repositories/tenant-quota.repository.js";
import type { QuotaService } from "@/services/quota.service.js";

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
    _headers: () => headers,
  };
  return res as never;
}

function makeCtx(method: string, url: string, body?: string): HttpContext {
  // Minimal IncomingMessage stub: emit a single chunk synchronously on
  // 'data', then an 'end'. readJsonBody attaches handlers in microtasks
  // so we have to defer to setImmediate.
  let dataHandler: ((chunk: Buffer) => void) | undefined;
  let endHandler: (() => void) | undefined;
  const req = {
    headers: {},
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === "data") dataHandler = handler as (chunk: Buffer) => void;
      if (event === "end") endHandler = handler as () => void;
      if (event === "error") { /* noop */ }
      setImmediate(() => {
        if (body && dataHandler) dataHandler(Buffer.from(body));
        if (endHandler) endHandler();
      });
      return req;
    },
    destroy() { /* noop */ },
  } as never;
  return {
    req, res: makeRes(),
    url, method, params: {}, query: new URLSearchParams(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  };
}

function jsonOf(ctx: HttpContext) {
  const r = ctx.res as unknown as { statusCode: number; _body: () => string };
  return { statusCode: r.statusCode, body: JSON.parse(r._body()) };
}

const sampleQuota: TenantQuotaEntity = {
  id: "q1",
  tenantId: "default",
  tier: "free",
  maxUsers: 3,
  maxSkills: 20,
  maxStorageBytes: 100 * 1024 * 1024,
  maxApiCallsPerDay: 1000,
  maxPipelineRunsPerDay: 50,
  effectiveFrom: 1000,
  effectiveUntil: null,
  notes: null,
};

const sampleOverride: QuotaOverrideEntity = {
  id: "o1",
  tenantId: "default",
  fieldName: "max_api_calls_per_day",
  overrideValue: 5000,
  reason: "promo Q3",
  grantedBy: "admin",
  grantedAt: 2000,
  expiresAt: null,
};

function setup(opts: { withDeps?: boolean } = {}) {
  const ensureSeeded = vi.fn().mockReturnValue(sampleQuota);
  const findCurrent = vi.fn().mockReturnValue(sampleQuota);
  const create = vi.fn().mockReturnValue(sampleQuota);
  const changeTier = vi.fn().mockImplementation((input) => ({ ...sampleQuota, tier: input.tier, maxUsers: input.maxUsers }));
  const listHistory = vi.fn().mockReturnValue([sampleQuota]);
  const listActiveOverrides = vi.fn().mockReturnValue([sampleOverride]);
  const listAllOverrides = vi.fn().mockReturnValue([sampleOverride, { ...sampleOverride, id: "o-old", expiresAt: 100 }]);
  const createOverride = vi.fn().mockReturnValue(sampleOverride);
  const deleteOverride = vi.fn().mockReturnValue(true);

  const repo = {
    ensureSeeded, findCurrent, create, changeTier, listHistory,
    listActiveOverrides, listAllOverrides, createOverride, deleteOverride,
  } as unknown as TenantQuotaRepository;

  const invalidate = vi.fn();
  const quotaService = { invalidate } as unknown as QuotaService;

  const router = new Router();
  router.use(errorMap("Admin operation failed"));
  registerAdminQuotaRoutes(router, {
    tenantQuotaRepo: opts.withDeps === false ? undefined : repo,
    quotaService: opts.withDeps === false ? undefined : quotaService,
  } as unknown as AppDependencies);

  return {
    router, repo, quotaService,
    ensureSeeded, findCurrent, create, changeTier, listHistory,
    listActiveOverrides, listAllOverrides, createOverride, deleteOverride,
    invalidate,
  };
}

describe("registerAdminQuotaRoutes (P1-13.5)", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  describe("GET /api/admin/tenants/:tenantId/quota", () => {
    it("returns the current row with snake_case JSON", async () => {
      const ctx = makeCtx("GET", "/api/admin/tenants/default/quota");
      await s.router.dispatch(ctx);
      const out = jsonOf(ctx);
      expect(out.statusCode).toBe(200);
      expect(out.body.data).toMatchObject({
        id: "q1",
        tenant_id: "default",
        tier: "free",
        max_users: 3,
        max_api_calls_per_day: 1000,
        max_pipeline_runs_per_day: 50,
      });
      expect(s.ensureSeeded).toHaveBeenCalledWith("default", "free");
    });

    it("rejects an invalid tenantId with 400", async () => {
      // Spaces (URL-decoded) violate the [a-zA-Z0-9_.-]+ allow-list.
      const ctx = makeCtx("GET", "/api/admin/tenants/bad%20tenant/quota");
      await s.router.dispatch(ctx);
      expect(jsonOf(ctx).statusCode).toBe(400);
      expect(s.ensureSeeded).not.toHaveBeenCalled();
    });
  });

  describe("PUT /api/admin/tenants/:tenantId/quota", () => {
    it("calls changeTier with tier defaults when only tier provided", async () => {
      const ctx = makeCtx("PUT", "/api/admin/tenants/default/quota", JSON.stringify({ tier: "team" }));
      await s.router.dispatch(ctx);
      const out = jsonOf(ctx);
      expect(out.statusCode).toBe(200);
      expect(s.changeTier).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: "default",
        tier: "team",
        maxUsers: 25,
        maxSkills: 200,
        maxApiCallsPerDay: 50000,
      }));
      expect(s.invalidate).toHaveBeenCalledWith("default");
    });

    it("uses .create when no current row exists", async () => {
      s.findCurrent.mockReturnValueOnce(null);
      const ctx = makeCtx("PUT", "/api/admin/tenants/default/quota", JSON.stringify({ tier: "free" }));
      await s.router.dispatch(ctx);
      expect(jsonOf(ctx).statusCode).toBe(200);
      expect(s.create).toHaveBeenCalled();
      expect(s.changeTier).not.toHaveBeenCalled();
    });

    it("merges body fields over tier defaults", async () => {
      const ctx = makeCtx("PUT", "/api/admin/tenants/default/quota", JSON.stringify({
        tier: "team",
        max_api_calls_per_day: 99999,
        notes: "custom",
      }));
      await s.router.dispatch(ctx);
      expect(s.changeTier).toHaveBeenCalledWith(expect.objectContaining({
        tier: "team",
        maxApiCallsPerDay: 99999,
        notes: "custom",
      }));
    });

    it("rejects an unknown tier with 400", async () => {
      const ctx = makeCtx("PUT", "/api/admin/tenants/default/quota", JSON.stringify({ tier: "platinum" }));
      await s.router.dispatch(ctx);
      expect(jsonOf(ctx).statusCode).toBe(400);
      expect(s.changeTier).not.toHaveBeenCalled();
    });

    it("rejects a negative limit with 400", async () => {
      const ctx = makeCtx("PUT", "/api/admin/tenants/default/quota", JSON.stringify({ tier: "free", max_users: -1 }));
      await s.router.dispatch(ctx);
      expect(jsonOf(ctx).statusCode).toBe(400);
    });
  });

  describe("GET /api/admin/tenants/:tenantId/quota/history", () => {
    it("returns rows ordered by repository (newest first)", async () => {
      s.listHistory.mockReturnValueOnce([
        { ...sampleQuota, id: "q2", effectiveFrom: 2000 },
        { ...sampleQuota, id: "q1", effectiveFrom: 1000, effectiveUntil: 2000 },
      ]);
      const ctx = makeCtx("GET", "/api/admin/tenants/default/quota/history");
      await s.router.dispatch(ctx);
      const out = jsonOf(ctx);
      expect(out.statusCode).toBe(200);
      expect(out.body.total).toBe(2);
      expect(out.body.data[0].id).toBe("q2");
    });

    it("returns 404 when there is no history at all", async () => {
      s.listHistory.mockReturnValueOnce([]);
      const ctx = makeCtx("GET", "/api/admin/tenants/default/quota/history");
      await s.router.dispatch(ctx);
      expect(jsonOf(ctx).statusCode).toBe(404);
    });
  });

  describe("GET /api/admin/tenants/:tenantId/overrides", () => {
    it("defaults to listActiveOverrides", async () => {
      const ctx = makeCtx("GET", "/api/admin/tenants/default/overrides");
      await s.router.dispatch(ctx);
      const out = jsonOf(ctx);
      expect(out.statusCode).toBe(200);
      expect(s.listActiveOverrides).toHaveBeenCalledWith("default");
      expect(s.listAllOverrides).not.toHaveBeenCalled();
      expect(out.body.data[0]).toMatchObject({
        id: "o1", field_name: "max_api_calls_per_day", override_value: 5000, reason: "promo Q3",
      });
    });

    it("uses listAllOverrides when ?all=true", async () => {
      const ctx = makeCtx("GET", "/api/admin/tenants/default/overrides");
      ctx.query.set("all", "true");
      await s.router.dispatch(ctx);
      expect(s.listAllOverrides).toHaveBeenCalledWith("default");
      expect(s.listActiveOverrides).not.toHaveBeenCalled();
      const out = jsonOf(ctx);
      expect(out.body.total).toBe(2);
    });
  });

  describe("POST /api/admin/tenants/:tenantId/overrides", () => {
    it("creates an override and invalidates the tenant cache", async () => {
      const body = JSON.stringify({
        field_name: "max_api_calls_per_day",
        override_value: 5000,
        reason: "promo Q3",
        granted_by: "admin",
      });
      const ctx = makeCtx("POST", "/api/admin/tenants/default/overrides", body);
      await s.router.dispatch(ctx);
      const out = jsonOf(ctx);
      expect(out.statusCode).toBe(201);
      expect(s.createOverride).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: "default",
        fieldName: "max_api_calls_per_day",
        overrideValue: 5000,
        reason: "promo Q3",
        grantedBy: "admin",
        expiresAt: null,
      }));
      expect(s.invalidate).toHaveBeenCalledWith("default");
    });

    it("rejects empty reason with 400", async () => {
      const body = JSON.stringify({
        field_name: "max_api_calls_per_day",
        override_value: 5000,
        reason: "   ",
        granted_by: "admin",
      });
      const ctx = makeCtx("POST", "/api/admin/tenants/default/overrides", body);
      await s.router.dispatch(ctx);
      expect(jsonOf(ctx).statusCode).toBe(400);
      expect(s.createOverride).not.toHaveBeenCalled();
    });

    it("rejects unknown field_name with 400", async () => {
      const body = JSON.stringify({
        field_name: "max_widgets",
        override_value: 5,
        reason: "x",
        granted_by: "admin",
      });
      const ctx = makeCtx("POST", "/api/admin/tenants/default/overrides", body);
      await s.router.dispatch(ctx);
      expect(jsonOf(ctx).statusCode).toBe(400);
    });

    it("rejects past expires_at with 400", async () => {
      const body = JSON.stringify({
        field_name: "max_api_calls_per_day",
        override_value: 5000,
        reason: "x",
        granted_by: "admin",
        expires_at: 100, // way in the past
      });
      const ctx = makeCtx("POST", "/api/admin/tenants/default/overrides", body);
      await s.router.dispatch(ctx);
      expect(jsonOf(ctx).statusCode).toBe(400);
    });

    it("rejects missing granted_by with 400", async () => {
      const body = JSON.stringify({
        field_name: "max_api_calls_per_day",
        override_value: 5000,
        reason: "ok",
      });
      const ctx = makeCtx("POST", "/api/admin/tenants/default/overrides", body);
      await s.router.dispatch(ctx);
      expect(jsonOf(ctx).statusCode).toBe(400);
    });
  });

  describe("DELETE /api/admin/quota-overrides/:overrideId", () => {
    it("deletes and invalidates when tenantId is supplied", async () => {
      const ctx = makeCtx("DELETE", "/api/admin/quota-overrides/o1");
      ctx.query.set("tenantId", "default");
      await s.router.dispatch(ctx);
      expect(jsonOf(ctx).statusCode).toBe(200);
      expect(s.deleteOverride).toHaveBeenCalledWith("o1");
      expect(s.invalidate).toHaveBeenCalledWith("default");
    });

    it("returns 404 when the override is not found", async () => {
      s.deleteOverride.mockReturnValueOnce(false);
      const ctx = makeCtx("DELETE", "/api/admin/quota-overrides/missing");
      await s.router.dispatch(ctx);
      expect(jsonOf(ctx).statusCode).toBe(404);
      expect(s.invalidate).not.toHaveBeenCalled();
    });

    it("does not call invalidate when tenantId omitted", async () => {
      const ctx = makeCtx("DELETE", "/api/admin/quota-overrides/o1");
      await s.router.dispatch(ctx);
      expect(jsonOf(ctx).statusCode).toBe(200);
      expect(s.invalidate).not.toHaveBeenCalled();
    });
  });

  it("does nothing when tenantQuotaRepo / quotaService missing", () => {
    const router = new Router();
    expect(() => registerAdminQuotaRoutes(router, {} as unknown as AppDependencies)).not.toThrow();
  });
});
