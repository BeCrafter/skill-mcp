import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@/db/migrate.js";
import { getDatabase, closeDatabase } from "@/db/connection.js";
import { TenantQuotaRepository, DEFAULT_TIER_LIMITS } from "@/db/repositories/tenant-quota.repository.js";
import { UsageEventRepository } from "@/db/repositories/usage-event.repository.js";
import { UsageMeterService } from "@/services/usage-meter.service.js";
import { QuotaService } from "@/services/quota.service.js";
import { createQuotaCheck } from "@/http/middleware/quota-check.js";
import type { HttpContext } from "@/http/context.js";

// I-08 — Quota enforcement integration test (review §16.4).
//
// Wires a real SQLite + UsageMeterService + QuotaService + quota-check
// middleware, hits the middleware until the daily quota is exhausted, and
// asserts the 429 response shape + cache invalidation behaviour. This is the
// "minimum viable" §16 integration test for the P1-13.5 deliverable —
// previously only single-layer mocked unit tests covered each piece.

function makeRes() {
  let body = "";
  const headers: Record<string, string> = {};
  return {
    headersSent: false,
    statusCode: 0,
    setHeader: vi.fn((k: string, v: string) => { headers[k.toLowerCase()] = String(v); }),
    writeHead: vi.fn(function (this: { headersSent: boolean; statusCode: number }, status: number, h?: Record<string, string>) {
      this.statusCode = status;
      this.headersSent = true;
      if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    }),
    write: vi.fn(),
    end: vi.fn(function (this: { headersSent: boolean }, chunk?: string | Buffer) {
      if (chunk) body += chunk.toString();
      this.headersSent = true;
    }),
    _body: () => body,
    _headers: () => headers,
  } as never;
}

function ctxFor(tenantId: string): HttpContext {
  return {
    req: { headers: {} } as never,
    res: makeRes(),
    url: "/api/gateway/skills",
    method: "GET",
    params: {},
    query: new URLSearchParams(),
    requestContext: { tenantId, userId: "anonymous", roleIds: [], tags: new Set(), sessionId: "s1", isAdmin: false },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  };
}

function readBody(ctx: HttpContext): { statusCode: number; body: unknown; headers: Record<string, string> } {
  const r = ctx.res as unknown as { statusCode: number; _body: () => string; _headers: () => Record<string, string> };
  const raw = r._body();
  return { statusCode: r.statusCode, body: raw ? JSON.parse(raw) : null, headers: r._headers() };
}

describe("Integration: Quota enforcement (I-08, review §16.4)", () => {
  let testDir: string;
  let dbPath: string;
  let quotaService: QuotaService;
  let usageMeter: UsageMeterService;
  let quotaRepo: TenantQuotaRepository;
  const TENANT = "tenant-i08";

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "i08-quota-"));
    dbPath = join(testDir, "test.db");
    runMigrations(dbPath);
    const db = getDatabase(dbPath);

    const usageRepo = new UsageEventRepository(db);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
    usageMeter = new UsageMeterService(usageRepo, logger);
    quotaRepo = new TenantQuotaRepository(db);
    quotaService = new QuotaService(quotaRepo, usageMeter, logger);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("allows requests within the free tier daily api_calls budget", async () => {
    const middleware = createQuotaCheck({ quotaService, dimension: "api_calls", scope: "gateway" });
    const ctx = ctxFor(TENANT);
    let nextCalled = false;
    await middleware(ctx, async () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    const out = readBody(ctx);
    expect(out.headers["x-quota-limit"]).toBe("1000"); // free tier default
    expect(out.headers["x-quota-source"]).toBe("tier");
    expect(Number(out.headers["x-quota-remaining"])).toBeGreaterThanOrEqual(0);
  });

  it("denies the request that would breach the limit and returns the documented 429 envelope", async () => {
    // Override free tier api_calls down to 3 so the test runs in milliseconds.
    await quotaRepo.ensureSeeded(TENANT, "free");
    await quotaRepo.changeTier({
      tenantId: TENANT,
      tier: "free",
      ...DEFAULT_TIER_LIMITS.free,
      maxApiCallsPerDay: 3,
    });
    quotaService.invalidate(TENANT);

    // Simulate 3 prior api.call events already recorded today.
    for (let i = 0; i < 3; i++) {
      usageMeter.recordSync({ tenantId: TENANT, eventType: "api.call", quantity: 1 });
    }

    const middleware = createQuotaCheck({ quotaService, dimension: "api_calls", scope: "gateway" });
    const ctx = ctxFor(TENANT);
    let nextCalled = false;
    await middleware(ctx, async () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    const out = readBody(ctx);
    expect(out.statusCode).toBe(429);
    expect(out.headers["retry-after"]).toBe("60");
    expect(out.body).toMatchObject({
      success: false,
      error: "Quota exceeded",
      dimension: "api_calls",
      limit: 3,
      used: 3,
      retryAfterSec: 60,
    });
  });

  it("invalidate(tenantId) makes a tier bump visible on the very next check (no 5s wait)", async () => {
    await quotaRepo.ensureSeeded(TENANT, "free");
    await quotaRepo.changeTier({
      tenantId: TENANT,
      tier: "free",
      ...DEFAULT_TIER_LIMITS.free,
      maxApiCallsPerDay: 1,
    });
    quotaService.invalidate(TENANT);

    usageMeter.recordSync({ tenantId: TENANT, eventType: "api.call", quantity: 1 });

    const middleware = createQuotaCheck({ quotaService, dimension: "api_calls", scope: "gateway" });

    // First call should deny — limit=1, used=1, projected=2.
    const ctx1 = ctxFor(TENANT);
    await middleware(ctx1, async () => { /* not reached */ });
    expect(readBody(ctx1).statusCode).toBe(429);

    // Bump tier without waiting for cache TTL.
    await quotaRepo.changeTier({
      tenantId: TENANT,
      tier: "team",
      ...DEFAULT_TIER_LIMITS.team,
    });
    quotaService.invalidate(TENANT);

    // Second call: team tier defaults to 50_000 api_calls/day — must pass.
    const ctx2 = ctxFor(TENANT);
    let allowed = false;
    await middleware(ctx2, async () => { allowed = true; });
    expect(allowed).toBe(true);
    expect(readBody(ctx2).headers["x-quota-limit"]).toBe("50000");
  });

  it("per-field override wins over tier and is reflected in headers", async () => {
    await quotaRepo.ensureSeeded(TENANT, "free");
    await quotaRepo.createOverride({
      tenantId: TENANT,
      fieldName: "max_api_calls_per_day",
      overrideValue: 9999,
      reason: "trial customer escalation",
      grantedBy: "admin@skill-mcp",
    });
    quotaService.invalidate(TENANT);

    const middleware = createQuotaCheck({ quotaService, dimension: "api_calls", scope: "gateway" });
    const ctx = ctxFor(TENANT);
    let allowed = false;
    await middleware(ctx, async () => { allowed = true; });

    expect(allowed).toBe(true);
    const out = readBody(ctx);
    expect(out.headers["x-quota-limit"]).toBe("9999");
    expect(out.headers["x-quota-source"]).toBe("override");
  });

  it("default skip predicate lets /health probe through without consulting QuotaService", async () => {
    const checkSpy = vi.spyOn(quotaService, "check");
    const middleware = createQuotaCheck({ quotaService, dimension: "api_calls", scope: "gateway" });
    const ctx = ctxFor(TENANT);
    ctx.url = "/health";
    let nextCalled = false;
    await middleware(ctx, async () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(checkSpy).not.toHaveBeenCalled();
  });
});
