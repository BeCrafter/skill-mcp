import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { json, readJsonBody } from "../../helpers.js";
import { BadRequestError, AppError } from "../../../utils/errors.js";
import { requireSuperadmin } from "../../middleware/admin-auth.js";
import {
  DEFAULT_TIER_LIMITS,
  type Tier,
  type QuotaField,
  type TenantQuotaEntity,
  type QuotaOverrideEntity,
} from "../../../db/repositories/tenant-quota.repository.js";

// P1-13.5 — Admin tier limits + per-field overrides (review §9.1, §11 #13.5).
//
// Surface:
//   GET    /api/admin/tenants/:tenantId/quota              — current row (auto-seeds free tier on first read)
//   PUT    /api/admin/tenants/:tenantId/quota              — changeTier or change individual limits
//   GET    /api/admin/tenants/:tenantId/quota/history      — chronological history (newest first)
//   GET    /api/admin/tenants/:tenantId/overrides          — active overrides (default) or all=true
//   POST   /api/admin/tenants/:tenantId/overrides          — create override (audit-grade reason required)
//   DELETE /api/admin/quota-overrides/:overrideId          — remove a single override
//
// Writes call quotaService.invalidate(tenantId) so the next quota check sees
// the new limits within one request, instead of waiting for the 5s cache TTL.

const VALID_TIERS = new Set<Tier>(["free", "team", "enterprise"]);
const VALID_FIELDS = new Set<QuotaField>([
  "max_users",
  "max_skills",
  "max_storage_bytes",
  "max_api_calls_per_day",
  "max_pipeline_runs_per_day",
]);

class QuotaNotFoundError extends AppError {
  constructor() { super("Quota row not found", "QUOTA_NOT_FOUND", 404); this.name = "QuotaNotFoundError"; }
}

class OverrideNotFoundError extends AppError {
  constructor() { super("Override not found", "OVERRIDE_NOT_FOUND", 404); this.name = "OverrideNotFoundError"; }
}

function requireTenantId(value: string | undefined): string {
  if (!value || value.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new BadRequestError("Invalid tenantId");
  }
  return value;
}

function requireOverrideId(value: string | undefined): string {
  if (!value || value.length > 128 || !/^[a-zA-Z0-9-]+$/.test(value)) {
    throw new BadRequestError("Invalid overrideId");
  }
  return value;
}

function requireTier(raw: unknown): Tier {
  if (typeof raw !== "string" || !VALID_TIERS.has(raw as Tier)) {
    throw new BadRequestError(`tier must be one of: ${Array.from(VALID_TIERS).join(", ")}`);
  }
  return raw as Tier;
}

function requireQuotaField(raw: unknown): QuotaField {
  if (typeof raw !== "string" || !VALID_FIELDS.has(raw as QuotaField)) {
    throw new BadRequestError(`field_name must be one of: ${Array.from(VALID_FIELDS).join(", ")}`);
  }
  return raw as QuotaField;
}

function requireNonNegativeInt(name: string, raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
    throw new BadRequestError(`${name} must be a non-negative integer`);
  }
  return raw;
}

function optionalNonNegativeInt(name: string, raw: unknown): number | undefined {
  if (raw == null) return undefined;
  return requireNonNegativeInt(name, raw);
}

function quotaToJson(row: TenantQuotaEntity): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    tier: row.tier,
    max_users: row.maxUsers,
    max_skills: row.maxSkills,
    max_storage_bytes: row.maxStorageBytes,
    max_api_calls_per_day: row.maxApiCallsPerDay,
    max_pipeline_runs_per_day: row.maxPipelineRunsPerDay,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    notes: row.notes,
  };
}

function overrideToJson(row: QuotaOverrideEntity): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    field_name: row.fieldName,
    override_value: row.overrideValue,
    reason: row.reason,
    granted_by: row.grantedBy,
    granted_at: row.grantedAt,
    expires_at: row.expiresAt,
  };
}

interface PutQuotaBody {
  tier?: string;
  max_users?: number;
  max_skills?: number;
  max_storage_bytes?: number;
  max_api_calls_per_day?: number;
  max_pipeline_runs_per_day?: number;
  notes?: string | null;
}

interface PostOverrideBody {
  field_name?: string;
  override_value?: number;
  reason?: string;
  granted_by?: string;
  expires_at?: number | null;
}

export function registerAdminQuotaRoutes(router: Router, deps: AppDependencies): void {
  if (!deps.tenantQuotaRepo || !deps.quotaService) return;
  const { tenantQuotaRepo: repo, quotaService } = deps;

  router.get("/api/admin/tenants/:tenantId/quota", async (ctx) => {
    const tenantId = requireTenantId(ctx.params.tenantId);
    // ensureSeeded so a freshly bootstrapped admin call doesn't 404 — the
    // QuotaService also auto-seeds on first hot-path check, mirror that here.
    const row = await repo.ensureSeeded(tenantId, "free");
    json(ctx.res, 200, { success: true, data: quotaToJson(row) });
  });

  router.put("/api/admin/tenants/:tenantId/quota", async (ctx) => {
    requireSuperadmin(ctx.requestContext!);
    const tenantId = requireTenantId(ctx.params.tenantId);
    const data = await readJsonBody<PutQuotaBody>(ctx.req);
    const tier = requireTier(data.tier);
    // When the body specifies fields, those win; otherwise fall back to the
    // tier's default template. This lets an admin "promote to team" with a
    // single field, or fine-tune a tier's numbers without losing the label.
    const defaults = DEFAULT_TIER_LIMITS[tier];
    const next = {
      tenantId,
      tier,
      maxUsers: optionalNonNegativeInt("max_users", data.max_users) ?? defaults.maxUsers,
      maxSkills: optionalNonNegativeInt("max_skills", data.max_skills) ?? defaults.maxSkills,
      maxStorageBytes: optionalNonNegativeInt("max_storage_bytes", data.max_storage_bytes) ?? defaults.maxStorageBytes,
      maxApiCallsPerDay: optionalNonNegativeInt("max_api_calls_per_day", data.max_api_calls_per_day) ?? defaults.maxApiCallsPerDay,
      maxPipelineRunsPerDay: optionalNonNegativeInt("max_pipeline_runs_per_day", data.max_pipeline_runs_per_day) ?? defaults.maxPipelineRunsPerDay,
      notes: data.notes == null ? null : String(data.notes).slice(0, 1024),
    };
    const existing = repo.findCurrent(tenantId);
    const updated = existing ? await repo.changeTier(next) : await repo.create(next);
    quotaService.invalidate(tenantId);
    json(ctx.res, 200, { success: true, data: quotaToJson(updated) });
  });

  router.get("/api/admin/tenants/:tenantId/quota/history", async (ctx) => {
    const tenantId = requireTenantId(ctx.params.tenantId);
    const rows = repo.listHistory(tenantId);
    if (rows.length === 0) throw new QuotaNotFoundError();
    json(ctx.res, 200, { success: true, data: rows.map(quotaToJson), total: rows.length });
  });

  router.get("/api/admin/tenants/:tenantId/overrides", async (ctx) => {
    const tenantId = requireTenantId(ctx.params.tenantId);
    const all = ctx.query.get("all") === "true";
    const rows = all ? repo.listAllOverrides(tenantId) : repo.listActiveOverrides(tenantId);
    json(ctx.res, 200, { success: true, data: rows.map(overrideToJson), total: rows.length });
  });

  router.post("/api/admin/tenants/:tenantId/overrides", async (ctx) => {
    requireSuperadmin(ctx.requestContext!);
    const tenantId = requireTenantId(ctx.params.tenantId);
    const data = await readJsonBody<PostOverrideBody>(ctx.req);
    const fieldName = requireQuotaField(data.field_name);
    const overrideValue = requireNonNegativeInt("override_value", data.override_value);
    if (typeof data.reason !== "string" || !data.reason.trim()) {
      throw new BadRequestError("reason is required (audit-grade text, non-empty)");
    }
    if (typeof data.granted_by !== "string" || !data.granted_by.trim()) {
      throw new BadRequestError("granted_by is required");
    }
    let expiresAt: number | null = null;
    if (data.expires_at != null) {
      if (typeof data.expires_at !== "number" || !Number.isFinite(data.expires_at) || data.expires_at <= Date.now()) {
        throw new BadRequestError("expires_at must be a future epoch ms");
      }
      expiresAt = Math.floor(data.expires_at);
    }
    const row = await repo.createOverride({
      tenantId,
      fieldName,
      overrideValue,
      reason: data.reason,
      grantedBy: data.granted_by,
      expiresAt,
    });
    quotaService.invalidate(tenantId);
    json(ctx.res, 201, { success: true, data: overrideToJson(row) });
  });

  router.delete("/api/admin/quota-overrides/:overrideId", async (ctx) => {
    requireSuperadmin(ctx.requestContext!);
    const overrideId = requireOverrideId(ctx.params.overrideId);
    // Look up the row first so we can invalidate the right tenant's cache.
    // listAllOverrides on every tenant would be wasteful; instead the body
    // carries the tenant via a tenantId query param (admin already has it
    // when issuing the delete). When absent, we still delete and rely on
    // the 5s TTL to cover the gap.
    const tenantId = ctx.query.get("tenantId");
    const ok = repo.deleteOverride(overrideId);
    if (!ok) throw new OverrideNotFoundError();
    if (tenantId) quotaService.invalidate(tenantId);
    json(ctx.res, 200, { success: true });
  });
}
