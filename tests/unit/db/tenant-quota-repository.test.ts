import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema.js";
import {
  TenantQuotaRepository,
  DEFAULT_TIER_LIMITS,
} from "@/db/repositories/tenant-quota.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; repo: TenantQuotaRepository } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE tenant_quotas (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    max_users INTEGER NOT NULL,
    max_skills INTEGER NOT NULL,
    max_storage_bytes INTEGER NOT NULL,
    max_api_calls_per_day INTEGER NOT NULL,
    max_pipeline_runs_per_day INTEGER NOT NULL,
    effective_from INTEGER NOT NULL,
    effective_until INTEGER,
    notes TEXT
  )`);
  db.run(`CREATE INDEX idx_tenant_quotas_tenant ON tenant_quotas(tenant_id, effective_until)`);
  db.run(`CREATE TABLE tenant_quota_overrides (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    override_value INTEGER NOT NULL,
    reason TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    expires_at INTEGER
  )`);
  db.run(`CREATE INDEX idx_tenant_quota_overrides_lookup ON tenant_quota_overrides(tenant_id, field_name, expires_at)`);
  return { db, repo: new TenantQuotaRepository(db) };
}

describe("TenantQuotaRepository (P1-13.5)", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  describe("ensureSeeded", () => {
    it("creates a free-tier row on first call", () => {
      const row = ctx.repo.ensureSeeded("default");
      expect(row.tier).toBe("free");
      expect(row.maxUsers).toBe(DEFAULT_TIER_LIMITS.free.maxUsers);
      expect(row.maxStorageBytes).toBe(DEFAULT_TIER_LIMITS.free.maxStorageBytes);
      expect(row.effectiveUntil).toBeNull();
    });

    it("is idempotent — second call returns the existing row, does not switch tier", () => {
      const first = ctx.repo.ensureSeeded("default", "free");
      const second = ctx.repo.ensureSeeded("default", "team"); // request team
      expect(second.id).toBe(first.id);
      expect(second.tier).toBe("free"); // still free
    });

    it("seeds team / enterprise tier with their respective limits", () => {
      const team = ctx.repo.ensureSeeded("tenant-a", "team");
      expect(team.tier).toBe("team");
      expect(team.maxApiCallsPerDay).toBe(DEFAULT_TIER_LIMITS.team.maxApiCallsPerDay);
      const ent = ctx.repo.ensureSeeded("tenant-b", "enterprise");
      expect(ent.tier).toBe("enterprise");
      expect(ent.maxStorageBytes).toBe(DEFAULT_TIER_LIMITS.enterprise.maxStorageBytes);
    });
  });

  describe("findCurrent", () => {
    it("returns null when nothing seeded", () => {
      expect(ctx.repo.findCurrent("default")).toBeNull();
    });

    it("returns the row with effective_until IS NULL", () => {
      ctx.repo.ensureSeeded("default", "free");
      const row = ctx.repo.findCurrent("default");
      expect(row?.tier).toBe("free");
    });

    it("ignores rows whose effective_until has been stamped (history)", () => {
      const row = ctx.repo.ensureSeeded("default", "free");
      // Manually stamp effective_until to simulate history.
      ctx.db.run(`UPDATE tenant_quotas SET effective_until = 100 WHERE id = '${row.id}'`);
      expect(ctx.repo.findCurrent("default")).toBeNull();
    });
  });

  describe("changeTier", () => {
    it("stamps the old current row and inserts a new current row", () => {
      const before = ctx.repo.ensureSeeded("default", "free");
      const after = ctx.repo.changeTier({
        tenantId: "default",
        tier: "team",
        ...DEFAULT_TIER_LIMITS.team,
        notes: "upgraded by ops",
      });
      expect(after.id).not.toBe(before.id);
      expect(after.tier).toBe("team");
      expect(after.notes).toBe("upgraded by ops");
      expect(after.effectiveUntil).toBeNull();
      const history = ctx.repo.listHistory("default");
      expect(history).toHaveLength(2);
      // The stamped (old) row should have a non-null effective_until equal to the new row's effective_from.
      const oldRow = history.find(r => r.id === before.id);
      expect(oldRow?.effectiveUntil).toBe(after.effectiveFrom);
    });

    it("only ever leaves one current row per tenant after multiple changes", () => {
      ctx.repo.ensureSeeded("default", "free");
      ctx.repo.changeTier({ tenantId: "default", tier: "team", ...DEFAULT_TIER_LIMITS.team });
      ctx.repo.changeTier({ tenantId: "default", tier: "enterprise", ...DEFAULT_TIER_LIMITS.enterprise });
      const all = ctx.repo.listHistory("default");
      const open = all.filter(r => r.effectiveUntil === null);
      expect(open).toHaveLength(1);
      expect(open[0].tier).toBe("enterprise");
    });

    it("isolates tenants — changing tenant-A does not stamp tenant-B's row", () => {
      const a = ctx.repo.ensureSeeded("tenant-a", "free");
      ctx.repo.ensureSeeded("tenant-b", "free");
      ctx.repo.changeTier({ tenantId: "tenant-a", tier: "team", ...DEFAULT_TIER_LIMITS.team });
      expect(ctx.repo.findCurrent("tenant-b")?.tier).toBe("free");
      const aHistory = ctx.repo.listHistory("tenant-a");
      expect(aHistory.find(r => r.id === a.id)?.effectiveUntil).not.toBeNull();
    });
  });

  describe("createOverride", () => {
    it("inserts an override with explicit expires_at = null (permanent)", () => {
      const ov = ctx.repo.createOverride({
        tenantId: "default",
        fieldName: "max_skills",
        overrideValue: 5000,
        reason: "Pilot customer raised the cap",
        grantedBy: "admin-1",
      });
      expect(ov.expiresAt).toBeNull();
      expect(ov.reason).toBe("Pilot customer raised the cap");
    });

    it("rejects empty / whitespace-only reason (audit-grade text)", () => {
      expect(() => ctx.repo.createOverride({
        tenantId: "default", fieldName: "max_skills",
        overrideValue: 100, reason: "  ", grantedBy: "admin-1",
      })).toThrow(/reason is required/);
    });

    it("preserves explicit expires_at", () => {
      const ov = ctx.repo.createOverride({
        tenantId: "default", fieldName: "max_api_calls_per_day",
        overrideValue: 10_000, reason: "Burst", grantedBy: "admin-1",
        expiresAt: 5_000,
      });
      expect(ov.expiresAt).toBe(5_000);
    });
  });

  describe("listActiveOverrides", () => {
    it("returns only un-expired overrides at the given clock time", () => {
      ctx.repo.createOverride({
        tenantId: "default", fieldName: "max_skills",
        overrideValue: 100, reason: "perm", grantedBy: "a",
      });
      ctx.repo.createOverride({
        tenantId: "default", fieldName: "max_users",
        overrideValue: 50, reason: "expired", grantedBy: "a",
        expiresAt: 1000, grantedAt: 500,
      });
      ctx.repo.createOverride({
        tenantId: "default", fieldName: "max_api_calls_per_day",
        overrideValue: 200, reason: "still active", grantedBy: "a",
        expiresAt: 5000, grantedAt: 500,
      });
      const active = ctx.repo.listActiveOverrides("default", 2000);
      expect(active.map(o => o.fieldName).sort()).toEqual([
        "max_api_calls_per_day", "max_skills",
      ]);
    });

    it("freshest override sorts first when multiple cover the same field", () => {
      ctx.repo.createOverride({
        tenantId: "default", fieldName: "max_skills",
        overrideValue: 100, reason: "first", grantedBy: "a", grantedAt: 1000,
      });
      ctx.repo.createOverride({
        tenantId: "default", fieldName: "max_skills",
        overrideValue: 200, reason: "second", grantedBy: "a", grantedAt: 2000,
      });
      const active = ctx.repo.listActiveOverrides("default", 3000);
      expect(active[0].overrideValue).toBe(200);
    });

    it("isolates tenants", () => {
      ctx.repo.createOverride({
        tenantId: "default", fieldName: "max_skills",
        overrideValue: 100, reason: "p", grantedBy: "a",
      });
      ctx.repo.createOverride({
        tenantId: "tenant-x", fieldName: "max_skills",
        overrideValue: 200, reason: "q", grantedBy: "a",
      });
      expect(ctx.repo.listActiveOverrides("default")).toHaveLength(1);
      expect(ctx.repo.listActiveOverrides("tenant-x")).toHaveLength(1);
    });
  });

  describe("deleteOverride", () => {
    it("returns true when a row was removed, false otherwise", () => {
      const ov = ctx.repo.createOverride({
        tenantId: "default", fieldName: "max_skills",
        overrideValue: 100, reason: "x", grantedBy: "a",
      });
      expect(ctx.repo.deleteOverride(ov.id)).toBe(true);
      expect(ctx.repo.deleteOverride(ov.id)).toBe(false);
      expect(ctx.repo.listActiveOverrides("default")).toHaveLength(0);
    });
  });

  describe("listAllOverrides (audit view)", () => {
    it("includes expired rows", () => {
      ctx.repo.createOverride({
        tenantId: "default", fieldName: "max_skills",
        overrideValue: 100, reason: "expired", grantedBy: "a",
        expiresAt: 1, grantedAt: 0,
      });
      const all = ctx.repo.listAllOverrides("default");
      expect(all).toHaveLength(1);
      expect(ctx.repo.listActiveOverrides("default", 1000)).toHaveLength(0);
    });
  });
});
