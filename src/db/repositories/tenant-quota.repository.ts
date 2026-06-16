import { and, eq, gt, isNull, or, desc } from "drizzle-orm";
import { shortId, generateUniqueId } from "../../utils/id.js";
import type { DrizzleDB } from "../connection.js";
import { tenantQuotas, tenantQuotaOverrides } from "../schema.js";

// P1-13.5 — Tier limits + per-field overrides (review §9.1, §11 #13.5).
//
// Storage shape:
//   • `tenant_quotas` rows with `effective_until IS NULL` are the *current*
//     window. A tier change stamps the old row's `effective_until` and
//     inserts a new row in a single transaction (`changeTier`).
//   • `tenant_quota_overrides` are layered on top: each (tenant, field)
//     pair takes the override's value when active, falling back to the
//     tier value otherwise. Overrides with `expires_at IS NULL` are
//     permanent until removed; overrides whose `expires_at <= now` are
//     ignored (but kept for audit until manually purged).
//
// Hot-path performance: a single quota check is two indexed lookups
// (`tenant_quotas` by `(tenant_id, effective_until)`, `tenant_quota_overrides`
// by `(tenant_id, field_name, expires_at)`). For high-throughput tenants
// the resolved limit should be cached for the request lifetime.

export type Tier = "free" | "team" | "enterprise";

export type QuotaField =
  | "max_users"
  | "max_skills"
  | "max_storage_bytes"
  | "max_api_calls_per_day"
  | "max_pipeline_runs_per_day";

export interface TenantQuotaEntity {
  id: string;
  tenantId: string;
  tier: Tier;
  maxUsers: number;
  maxSkills: number;
  maxStorageBytes: number;
  maxApiCallsPerDay: number;
  maxPipelineRunsPerDay: number;
  effectiveFrom: number;
  effectiveUntil: number | null;
  notes: string | null;
}

export interface QuotaOverrideEntity {
  id: string;
  tenantId: string;
  fieldName: QuotaField;
  overrideValue: number;
  reason: string;
  grantedBy: string;
  grantedAt: number;
  expiresAt: number | null;
}

export interface CreateQuotaInput {
  tenantId: string;
  tier: Tier;
  maxUsers: number;
  maxSkills: number;
  maxStorageBytes: number;
  maxApiCallsPerDay: number;
  maxPipelineRunsPerDay: number;
  effectiveFrom?: number;
  notes?: string | null;
}

export interface CreateOverrideInput {
  tenantId: string;
  fieldName: QuotaField;
  overrideValue: number;
  reason: string;
  grantedBy: string;
  expiresAt?: number | null;
  /** Override the timestamp (epoch ms). Defaults to `Date.now()`. */
  grantedAt?: number;
}

/** Default tier templates (review §9.1). Used by `seedDefault`. */
export const DEFAULT_TIER_LIMITS: Record<Tier, Omit<CreateQuotaInput, "tenantId" | "tier">> = {
  free: {
    maxUsers: 3,
    maxSkills: 20,
    maxStorageBytes: 100 * 1024 * 1024,        // 100 MB
    maxApiCallsPerDay: 1_000,
    maxPipelineRunsPerDay: 50,
  },
  team: {
    maxUsers: 25,
    maxSkills: 200,
    maxStorageBytes: 5 * 1024 * 1024 * 1024,   // 5 GB
    maxApiCallsPerDay: 50_000,
    maxPipelineRunsPerDay: 500,
  },
  // Enterprise defaults are intentionally non-zero so a misconfigured tenant
  // doesn't suddenly hit "unlimited" — admins must override explicitly per
  // contract. Numbers picked to be obviously placeholder-ish.
  enterprise: {
    maxUsers: 1_000,
    maxSkills: 10_000,
    maxStorageBytes: 1024 * 1024 * 1024 * 1024, // 1 TB
    maxApiCallsPerDay: 10_000_000,
    maxPipelineRunsPerDay: 100_000,
  },
};

export class TenantQuotaRepository {
  constructor(private db: DrizzleDB) {}

  /** Return the *current* (effective_until IS NULL) row for a tenant, or null. */
  findCurrent(tenantId: string): TenantQuotaEntity | null {
    const row = this.db
      .select()
      .from(tenantQuotas)
      .where(and(eq(tenantQuotas.tenantId, tenantId), isNull(tenantQuotas.effectiveUntil)))
      .limit(1)
      .all()[0];
    return row ? this.toQuotaEntity(row) : null;
  }

  /** All rows (current + history) for a tenant, newest first. */
  listHistory(tenantId: string): TenantQuotaEntity[] {
    const rows = this.db
      .select()
      .from(tenantQuotas)
      .where(eq(tenantQuotas.tenantId, tenantId))
      .orderBy(desc(tenantQuotas.effectiveFrom))
      .all();
    return rows.map(r => this.toQuotaEntity(r));
  }

  /**
   * Insert a new current row. Caller is responsible for making sure no other
   * row with `effective_until IS NULL` exists for this tenant — use
   * `changeTier()` for atomic transitions.
   */
  async create(input: CreateQuotaInput): Promise<TenantQuotaEntity> {
    const id = await generateUniqueId(() => shortId(), async (id) => {
      const row = this.db.select({ id: tenantQuotas.id }).from(tenantQuotas).where(eq(tenantQuotas.id, id)).get();
      return !!row;
    });
    const effectiveFrom = input.effectiveFrom ?? Date.now();
    this.db.insert(tenantQuotas).values({
      id,
      tenantId: input.tenantId,
      tier: input.tier,
      maxUsers: input.maxUsers,
      maxSkills: input.maxSkills,
      maxStorageBytes: input.maxStorageBytes,
      maxApiCallsPerDay: input.maxApiCallsPerDay,
      maxPipelineRunsPerDay: input.maxPipelineRunsPerDay,
      effectiveFrom,
      effectiveUntil: null,
      notes: input.notes ?? null,
    }).run();
    return {
      id,
      tenantId: input.tenantId,
      tier: input.tier,
      maxUsers: input.maxUsers,
      maxSkills: input.maxSkills,
      maxStorageBytes: input.maxStorageBytes,
      maxApiCallsPerDay: input.maxApiCallsPerDay,
      maxPipelineRunsPerDay: input.maxPipelineRunsPerDay,
      effectiveFrom,
      effectiveUntil: null,
      notes: input.notes ?? null,
    };
  }

  /**
   * Stamp the existing current row with `effective_until = now` and insert a
   * new current row with the supplied limits. Both happen in a single
   * transaction so a reader never sees zero or two current rows. Returns
   * the new row.
   */
  async changeTier(input: CreateQuotaInput): Promise<TenantQuotaEntity> {
    const now = input.effectiveFrom ?? Date.now();
    const id = await generateUniqueId(() => shortId(), async (id) => {
      const row = this.db.select({ id: tenantQuotas.id }).from(tenantQuotas).where(eq(tenantQuotas.id, id)).get();
      return !!row;
    });
    let result!: TenantQuotaEntity;
    this.db.transaction((tx) => {
      tx.update(tenantQuotas)
        .set({ effectiveUntil: now })
        .where(and(eq(tenantQuotas.tenantId, input.tenantId), isNull(tenantQuotas.effectiveUntil)))
        .run();
      tx.insert(tenantQuotas).values({
        id,
        tenantId: input.tenantId,
        tier: input.tier,
        maxUsers: input.maxUsers,
        maxSkills: input.maxSkills,
        maxStorageBytes: input.maxStorageBytes,
        maxApiCallsPerDay: input.maxApiCallsPerDay,
        maxPipelineRunsPerDay: input.maxPipelineRunsPerDay,
        effectiveFrom: now,
        effectiveUntil: null,
        notes: input.notes ?? null,
      }).run();
      result = {
        id,
        tenantId: input.tenantId,
        tier: input.tier,
        maxUsers: input.maxUsers,
        maxSkills: input.maxSkills,
        maxStorageBytes: input.maxStorageBytes,
        maxApiCallsPerDay: input.maxApiCallsPerDay,
        maxPipelineRunsPerDay: input.maxPipelineRunsPerDay,
        effectiveFrom: now,
        effectiveUntil: null,
        notes: input.notes ?? null,
      };
    });
    return result;
  }

  /**
   * Idempotently ensure a tenant has a current row at the given tier. If the
   * tenant already has a current row, return it unchanged (does NOT switch
   * tier). Use `changeTier` when you do want to migrate.
   */
  async ensureSeeded(tenantId: string, tier: Tier = "free"): Promise<TenantQuotaEntity> {
    const existing = this.findCurrent(tenantId);
    if (existing) return existing;
    const limits = DEFAULT_TIER_LIMITS[tier];
    return await this.create({ tenantId, tier, ...limits });
  }

  // --- Overrides -----------------------------------------------------------

  /**
   * Return all *active* overrides for a tenant — rows whose `expires_at` is
   * either NULL or strictly greater than `now`. Used by the resolver hot
   * path; ordered by `granted_at DESC` so a fresher override wins when
   * multiple exist for the same field.
   */
  listActiveOverrides(tenantId: string, now: number = Date.now()): QuotaOverrideEntity[] {
    const rows = this.db
      .select()
      .from(tenantQuotaOverrides)
      .where(and(
        eq(tenantQuotaOverrides.tenantId, tenantId),
        or(isNull(tenantQuotaOverrides.expiresAt), gt(tenantQuotaOverrides.expiresAt, now)),
      ))
      .orderBy(desc(tenantQuotaOverrides.grantedAt))
      .all();
    return rows.map(r => this.toOverrideEntity(r));
  }

  /** All overrides (active + expired) for a tenant. Admin audit view. */
  listAllOverrides(tenantId: string): QuotaOverrideEntity[] {
    const rows = this.db
      .select()
      .from(tenantQuotaOverrides)
      .where(eq(tenantQuotaOverrides.tenantId, tenantId))
      .orderBy(desc(tenantQuotaOverrides.grantedAt))
      .all();
    return rows.map(r => this.toOverrideEntity(r));
  }

  async createOverride(input: CreateOverrideInput): Promise<QuotaOverrideEntity> {
    const trimmedReason = input.reason.trim();
    if (!trimmedReason) {
      throw new Error("override reason is required (audit-grade text, non-empty)");
    }
    const id = await generateUniqueId(() => shortId(), async (id) => {
      const row = this.db.select({ id: tenantQuotaOverrides.id }).from(tenantQuotaOverrides).where(eq(tenantQuotaOverrides.id, id)).get();
      return !!row;
    });
    const grantedAt = input.grantedAt ?? Date.now();
    this.db.insert(tenantQuotaOverrides).values({
      id,
      tenantId: input.tenantId,
      fieldName: input.fieldName,
      overrideValue: input.overrideValue,
      reason: trimmedReason,
      grantedBy: input.grantedBy,
      grantedAt,
      expiresAt: input.expiresAt ?? null,
    }).run();
    return {
      id,
      tenantId: input.tenantId,
      fieldName: input.fieldName,
      overrideValue: input.overrideValue,
      reason: trimmedReason,
      grantedBy: input.grantedBy,
      grantedAt,
      expiresAt: input.expiresAt ?? null,
    };
  }

  deleteOverride(id: string): boolean {
    const result = this.db
      .delete(tenantQuotaOverrides)
      .where(eq(tenantQuotaOverrides.id, id))
      .run();
    return (result.changes ?? 0) > 0;
  }

  // --- mappers -------------------------------------------------------------

  private toQuotaEntity(row: typeof tenantQuotas.$inferSelect): TenantQuotaEntity {
    return {
      id: row.id,
      tenantId: row.tenantId,
      tier: row.tier as Tier,
      maxUsers: row.maxUsers,
      maxSkills: row.maxSkills,
      maxStorageBytes: row.maxStorageBytes,
      maxApiCallsPerDay: row.maxApiCallsPerDay,
      maxPipelineRunsPerDay: row.maxPipelineRunsPerDay,
      effectiveFrom: row.effectiveFrom,
      effectiveUntil: row.effectiveUntil ?? null,
      notes: row.notes ?? null,
    };
  }

  private toOverrideEntity(row: typeof tenantQuotaOverrides.$inferSelect): QuotaOverrideEntity {
    return {
      id: row.id,
      tenantId: row.tenantId,
      fieldName: row.fieldName as QuotaField,
      overrideValue: row.overrideValue,
      reason: row.reason,
      grantedBy: row.grantedBy,
      grantedAt: row.grantedAt,
      expiresAt: row.expiresAt ?? null,
    };
  }
}
