import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "pino";
import { QuotaService } from "@/services/quota.service.js";
import {
  DEFAULT_TIER_LIMITS,
  type TenantQuotaRepository,
  type TenantQuotaEntity,
  type QuotaOverrideEntity,
} from "@/db/repositories/tenant-quota.repository.js";
import type { UsageMeterService } from "@/services/usage-meter.service.js";

function fakeLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

function makeQuota(overrides: Partial<TenantQuotaEntity> = {}): TenantQuotaEntity {
  return {
    id: "q1",
    tenantId: "default",
    tier: "free",
    maxUsers: DEFAULT_TIER_LIMITS.free.maxUsers,
    maxSkills: DEFAULT_TIER_LIMITS.free.maxSkills,
    maxStorageBytes: DEFAULT_TIER_LIMITS.free.maxStorageBytes,
    maxApiCallsPerDay: DEFAULT_TIER_LIMITS.free.maxApiCallsPerDay,
    maxPipelineRunsPerDay: DEFAULT_TIER_LIMITS.free.maxPipelineRunsPerDay,
    effectiveFrom: 0,
    effectiveUntil: null,
    notes: null,
    ...overrides,
  };
}

function setup(opts: { overrides?: QuotaOverrideEntity[]; quota?: Partial<TenantQuotaEntity>; usage?: number } = {}) {
  const ensureSeeded = vi.fn().mockReturnValue(makeQuota(opts.quota));
  const listActiveOverrides = vi.fn().mockReturnValue(opts.overrides ?? []);
  const quotaRepo = { ensureSeeded, listActiveOverrides } as unknown as TenantQuotaRepository;
  const sumQuantity = vi.fn().mockReturnValue(opts.usage ?? 0);
  const usageMeter = { sumQuantity } as unknown as UsageMeterService;
  const logger = fakeLogger();
  const svc = new QuotaService(quotaRepo, usageMeter, logger);
  return { svc, quotaRepo, ensureSeeded, listActiveOverrides, sumQuantity, logger };
}

describe("QuotaService (P1-13.5)", () => {
  describe("resolveTenant", () => {
    it("auto-seeds via ensureSeeded(free) on first access", () => {
      const { svc, ensureSeeded } = setup();
      svc.resolveTenant("default");
      expect(ensureSeeded).toHaveBeenCalledWith("default", "free");
    });

    it("caches lookups for the TTL window (no second repo call)", () => {
      const { svc, ensureSeeded } = setup();
      svc.resolveTenant("default", 1000);
      svc.resolveTenant("default", 1500);
      expect(ensureSeeded).toHaveBeenCalledTimes(1);
    });

    it("invalidate() drops the cache so the next call hits the repo again", () => {
      const { svc, ensureSeeded } = setup();
      svc.resolveTenant("default", 1000);
      svc.invalidate("default");
      svc.resolveTenant("default", 1500);
      expect(ensureSeeded).toHaveBeenCalledTimes(2);
    });

    it("re-reads after the TTL expires", () => {
      const { svc, ensureSeeded } = setup();
      svc.resolveTenant("default", 0);
      svc.resolveTenant("default", 10_000);
      expect(ensureSeeded).toHaveBeenCalledTimes(2);
    });
  });

  describe("resolveLimit", () => {
    it("returns the tier value when no override matches the field", () => {
      const { svc } = setup();
      const r = svc.resolveLimit("default", "max_skills");
      expect(r.value).toBe(DEFAULT_TIER_LIMITS.free.maxSkills);
      expect(r.source).toBe("tier");
    });

    it("returns the override value when one matches", () => {
      const ov: QuotaOverrideEntity = {
        id: "o1", tenantId: "default", fieldName: "max_skills",
        overrideValue: 9999, reason: "VIP", grantedBy: "a",
        grantedAt: 0, expiresAt: null,
      };
      const { svc } = setup({ overrides: [ov] });
      const r = svc.resolveLimit("default", "max_skills");
      expect(r.value).toBe(9999);
      expect(r.source).toBe("override");
      expect(r.override?.id).toBe("o1");
    });

    it("ignores overrides that target a different field", () => {
      const ov: QuotaOverrideEntity = {
        id: "o1", tenantId: "default", fieldName: "max_users",
        overrideValue: 9999, reason: "x", grantedBy: "a",
        grantedAt: 0, expiresAt: null,
      };
      const { svc } = setup({ overrides: [ov] });
      const r = svc.resolveLimit("default", "max_skills");
      expect(r.source).toBe("tier");
    });
  });

  describe("check", () => {
    it("ok when projected (used+increment) ≤ limit", () => {
      const { svc } = setup({ usage: 100 });
      const r = svc.check({ tenantId: "default", dimension: "api_calls", increment: 1 });
      expect(r.ok).toBe(true);
      expect(r.used).toBe(100);
      expect(r.limit).toBe(DEFAULT_TIER_LIMITS.free.maxApiCallsPerDay);
      expect(r.remaining).toBe(DEFAULT_TIER_LIMITS.free.maxApiCallsPerDay - 100);
      expect(r.source).toBe("tier");
    });

    it("not-ok when projected > limit", () => {
      const { svc } = setup({ usage: DEFAULT_TIER_LIMITS.free.maxApiCallsPerDay });
      const r = svc.check({ tenantId: "default", dimension: "api_calls", increment: 1 });
      expect(r.ok).toBe(false);
      expect(r.remaining).toBe(0);
    });

    it("right at the limit (used == limit, increment 0) is ok", () => {
      const { svc } = setup({ usage: DEFAULT_TIER_LIMITS.free.maxApiCallsPerDay });
      const r = svc.check({ tenantId: "default", dimension: "api_calls", increment: 0 });
      expect(r.ok).toBe(true);
    });

    it("default increment is 1", () => {
      const { svc } = setup({ usage: DEFAULT_TIER_LIMITS.free.maxApiCallsPerDay - 1 });
      expect(svc.check({ tenantId: "default", dimension: "api_calls" }).ok).toBe(true);
      const { svc: svc2 } = setup({ usage: DEFAULT_TIER_LIMITS.free.maxApiCallsPerDay });
      expect(svc2.check({ tenantId: "default", dimension: "api_calls" }).ok).toBe(false);
    });

    it("queries usage_events with the UTC day window for daily dimensions", () => {
      const { svc, sumQuantity } = setup();
      const noon = Date.UTC(2026, 4, 28, 12, 0, 0);
      svc.check({ tenantId: "default", dimension: "api_calls", now: noon });
      expect(sumQuantity).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: "default",
        eventType: "api.call",
        fromBucket: "2026-05-28T00",
        toBucket: "2026-05-28T23",
      }));
    });

    it("storage_bytes dimension reads storage.write events", () => {
      const { svc, sumQuantity } = setup({ usage: 1024 });
      const r = svc.check({ tenantId: "default", dimension: "storage_bytes", increment: 100 });
      expect(sumQuantity).toHaveBeenCalledWith(expect.objectContaining({ eventType: "storage.write" }));
      expect(r.used).toBe(1024);
    });

    it("users / skills dimensions report used=0 (point-in-time counts deferred)", () => {
      const { svc, sumQuantity } = setup();
      const r = svc.check({ tenantId: "default", dimension: "skills", increment: 1 });
      expect(r.used).toBe(0);
      expect(sumQuantity).not.toHaveBeenCalled();
    });

    it("FAIL-OPEN — when ensureSeeded throws, returns ok with source=unknown", () => {
      const ensureSeeded = vi.fn().mockImplementation(() => { throw new Error("db down"); });
      const quotaRepo = { ensureSeeded, listActiveOverrides: vi.fn() } as unknown as TenantQuotaRepository;
      const usageMeter = { sumQuantity: vi.fn() } as unknown as UsageMeterService;
      const logger = fakeLogger();
      const svc = new QuotaService(quotaRepo, usageMeter, logger);
      const r = svc.check({ tenantId: "default", dimension: "api_calls" });
      expect(r.ok).toBe(true);
      expect(r.source).toBe("unknown");
      expect(r.limit).toBe(Number.POSITIVE_INFINITY);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("blank tenantId falls back to DEFAULT_TENANT_ID", () => {
      const { svc, ensureSeeded } = setup();
      svc.check({ tenantId: "", dimension: "api_calls" });
      expect(ensureSeeded).toHaveBeenCalledWith("default", "free");
    });

    it("override winning bumps the limit so a previously-blocked request now passes", () => {
      const ov: QuotaOverrideEntity = {
        id: "o1", tenantId: "default", fieldName: "max_api_calls_per_day",
        overrideValue: 50_000, reason: "burst", grantedBy: "a",
        grantedAt: 0, expiresAt: null,
      };
      const { svc } = setup({ overrides: [ov], usage: DEFAULT_TIER_LIMITS.free.maxApiCallsPerDay + 100 });
      const r = svc.check({ tenantId: "default", dimension: "api_calls", increment: 1 });
      expect(r.ok).toBe(true);
      expect(r.limit).toBe(50_000);
      expect(r.source).toBe("override");
    });
  });
});
