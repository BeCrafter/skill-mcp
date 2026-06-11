import { describe, it, expect, vi, beforeEach } from "vitest";
import { Router } from "@/http/router.js";
import { errorMap } from "@/http/middleware/error-map.js";
import { registerAdminUsageRoutes } from "@/http/handlers/admin/usage.handler.js";
import type { HttpContext } from "@/http/context.js";
import type { AppDependencies } from "@/app-dependencies.js";
import type {
  AggregateRow,
  UsageEventEntity,
} from "@/db/repositories/usage-event.repository.js";
import type { UsageMeterService } from "@/services/usage-meter.service.js";

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

function makeCtx(method: string, url: string): HttpContext {
  const req = { headers: {} } as never;
  return {
    req, res: makeRes(),
    url, method, params: {}, query: new URLSearchParams(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  };
}

function bodyOf(ctx: HttpContext) {
  const r = ctx.res as unknown as { statusCode: number; _body: () => string; _headers: () => Record<string, unknown> };
  return { statusCode: r.statusCode, body: r._body(), headers: r._headers() };
}

function jsonOf(ctx: HttpContext) {
  const out = bodyOf(ctx);
  return { statusCode: out.statusCode, body: JSON.parse(out.body) };
}

function setup(opts: { withRepo?: boolean } = {}) {
  const aggregate = vi.fn<(args: unknown) => AggregateRow[]>();
  const list = vi.fn<(args: unknown) => UsageEventEntity[]>();
  const usageMeter = { aggregate, list } as unknown as UsageMeterService;
  const router = new Router();
  router.use(errorMap("Admin operation failed"));
  registerAdminUsageRoutes(router, {
    usageMeter,
    usageEventRepo: opts.withRepo === false ? undefined : ({} as never),
  } as unknown as AppDependencies);
  return { aggregate, list, router };
}

describe("registerAdminUsageRoutes (P1-13)", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  describe("GET /api/admin/usage/aggregate", () => {
    it("returns rows as JSON with snake_case fields", async () => {
      const rows: AggregateRow[] = [
        { tenantId: "default", eventType: "skill.view", hourBucket: "2026-05-28T13", totalQuantity: 5, eventCount: 5 },
      ];
      ctx.aggregate.mockReturnValue(rows);
      const httpCtx = makeCtx("GET", "/api/admin/usage/aggregate");
      await ctx.router.dispatch(httpCtx);
      const out = jsonOf(httpCtx);
      expect(out.statusCode).toBe(200);
      expect(out.body.data).toEqual([{
        tenant_id: "default",
        event_type: "skill.view",
        hour_bucket: "2026-05-28T13",
        total_quantity: 5,
        event_count: 5,
      }]);
      expect(out.body.total).toBe(1);
      expect(ctx.aggregate).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "default" }));
    });

    it("passes through tenantId / eventType / fromBucket / toBucket query params", async () => {
      ctx.aggregate.mockReturnValue([]);
      const httpCtx = makeCtx("GET", "/api/admin/usage/aggregate");
      httpCtx.query.set("tenantId", "tenant-x");
      httpCtx.query.set("eventType", "pipeline.run");
      httpCtx.query.set("fromBucket", "2026-05-28T00");
      httpCtx.query.set("toBucket", "2026-05-28T23");
      await ctx.router.dispatch(httpCtx);
      expect(ctx.aggregate).toHaveBeenCalledWith({
        tenantId: "tenant-x",
        eventType: "pipeline.run",
        fromBucket: "2026-05-28T00",
        toBucket: "2026-05-28T23",
      });
    });

    it("rejects malformed hour bucket with 400", async () => {
      const httpCtx = makeCtx("GET", "/api/admin/usage/aggregate");
      httpCtx.query.set("fromBucket", "2026/05/28");
      await ctx.router.dispatch(httpCtx);
      expect(jsonOf(httpCtx).statusCode).toBe(400);
    });

    it("rejects unknown event type that doesn't match <domain>.<name>", async () => {
      const httpCtx = makeCtx("GET", "/api/admin/usage/aggregate");
      httpCtx.query.set("eventType", "BAD_TYPE");
      await ctx.router.dispatch(httpCtx);
      expect(jsonOf(httpCtx).statusCode).toBe(400);
    });

    it("accepts a custom <domain>.<name> event type beyond the canonical four", async () => {
      ctx.aggregate.mockReturnValue([]);
      const httpCtx = makeCtx("GET", "/api/admin/usage/aggregate");
      httpCtx.query.set("eventType", "embedding.search");
      await ctx.router.dispatch(httpCtx);
      expect(jsonOf(httpCtx).statusCode).toBe(200);
      expect(ctx.aggregate).toHaveBeenCalledWith(expect.objectContaining({ eventType: "embedding.search" }));
    });

    it("emits CSV when format=csv with correct content type and headers", async () => {
      const rows: AggregateRow[] = [
        { tenantId: "default", eventType: "skill.view", hourBucket: "2026-05-28T13", totalQuantity: 5, eventCount: 5 },
        { tenantId: "default", eventType: "pipeline.run", hourBucket: "2026-05-28T13", totalQuantity: 12, eventCount: 3 },
      ];
      ctx.aggregate.mockReturnValue(rows);
      const httpCtx = makeCtx("GET", "/api/admin/usage/aggregate");
      httpCtx.query.set("format", "csv");
      await ctx.router.dispatch(httpCtx);
      const out = bodyOf(httpCtx);
      expect(out.statusCode).toBe(200);
      expect(out.headers["Content-Type"]).toMatch(/text\/csv/);
      expect(out.headers["Content-Disposition"]).toMatch(/attachment; filename="usage-default\.csv"/);
      expect(out.body).toBe(
        "tenant_id,event_type,hour_bucket,total_quantity,event_count\n" +
        "default,skill.view,2026-05-28T13,5,5\n" +
        "default,pipeline.run,2026-05-28T13,12,3\n",
      );
    });

    it("emits CSV header even when there are no rows", async () => {
      ctx.aggregate.mockReturnValue([]);
      const httpCtx = makeCtx("GET", "/api/admin/usage/aggregate");
      httpCtx.query.set("format", "csv");
      await ctx.router.dispatch(httpCtx);
      const out = bodyOf(httpCtx);
      expect(out.body).toBe("tenant_id,event_type,hour_bucket,total_quantity,event_count\n");
    });

    it("rejects unknown format with 400", async () => {
      const httpCtx = makeCtx("GET", "/api/admin/usage/aggregate");
      httpCtx.query.set("format", "xml");
      await ctx.router.dispatch(httpCtx);
      expect(jsonOf(httpCtx).statusCode).toBe(400);
    });
  });

  describe("GET /api/admin/usage/events", () => {
    it("returns events with snake_case fields and respects limit", async () => {
      const events: UsageEventEntity[] = [
        {
          id: "e1", tenantId: "default", userId: "u1",
          eventType: "skill.view", resourceId: "demo",
          quantity: 1, metadata: { foo: "bar" },
          hourBucket: "2026-05-28T13", createdAt: 1000,
        },
      ];
      ctx.list.mockReturnValue(events);
      const httpCtx = makeCtx("GET", "/api/admin/usage/events");
      httpCtx.query.set("limit", "50");
      await ctx.router.dispatch(httpCtx);
      const out = jsonOf(httpCtx);
      expect(out.statusCode).toBe(200);
      expect(out.body.data).toEqual([{
        id: "e1",
        tenant_id: "default",
        user_id: "u1",
        event_type: "skill.view",
        resource_id: "demo",
        quantity: 1,
        metadata: { foo: "bar" },
        hour_bucket: "2026-05-28T13",
        created_at: 1000,
      }]);
      expect(ctx.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    });

    it("rejects limit out of range with 400", async () => {
      const httpCtx = makeCtx("GET", "/api/admin/usage/events");
      httpCtx.query.set("limit", "99999");
      await ctx.router.dispatch(httpCtx);
      expect(jsonOf(httpCtx).statusCode).toBe(400);
    });

    it("returns 500 ConfigurationError when usageEventRepo is not configured", async () => {
      const noRepoCtx = setup({ withRepo: false });
      const httpCtx = makeCtx("GET", "/api/admin/usage/events");
      await noRepoCtx.router.dispatch(httpCtx);
      const out = jsonOf(httpCtx);
      expect(out.statusCode).toBe(500);
    });
  });

  it("does nothing when usageMeter is missing from deps", () => {
    const router = new Router();
    expect(() => registerAdminUsageRoutes(router, {} as unknown as AppDependencies)).not.toThrow();
  });
});
