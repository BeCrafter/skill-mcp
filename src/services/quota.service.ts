import type { Logger } from "pino";
import type {
  TenantQuotaRepository,
  TenantQuotaEntity,
  QuotaField,
  QuotaOverrideEntity,
} from "../db/repositories/tenant-quota.repository.js";
import type { UsageMeterService } from "./usage-meter.service.js";
import { hourBucketOf } from "../db/repositories/usage-event.repository.js";
import { DEFAULT_TENANT_ID } from "../types/index.js";

// P1-13.5 — Quota service (review §9.1, §11 #13.5).
//
// Two responsibilities:
//   1. **Resolve** the effective limit for a (tenant, field) pair: tier
//      default unless an active override exists.
//   2. **Check** usage against limits — for the daily counters
//      (`max_api_calls_per_day` / `max_pipeline_runs_per_day` /
//      `max_storage_bytes`) we query `usage_events` directly via
//      `UsageMeterService.sumQuantity`. The counters table the review
//      mentions (Redis batched) is a future optimization; SQLite with the
//      covering index is fine at the volumes a free/team tier can produce.
//
// Quota check is **fail-open** by design — if reading limits or usage
// throws, we log a warn and let the request through. Failing a request
// because metering is down would convert a metering outage into an
// availability outage. This mirrors the fire-and-forget write path and
// is explicit in `check()` — see comments inside.

/** A single dimension we can quota-check. Each maps to a `QuotaField`. */
export type QuotaDimension =
  | "users"
  | "skills"
  | "storage_bytes"
  | "api_calls"
  | "pipeline_runs";

const DIMENSION_TO_FIELD: Record<QuotaDimension, QuotaField> = {
  users: "max_users",
  skills: "max_skills",
  storage_bytes: "max_storage_bytes",
  api_calls: "max_api_calls_per_day",
  pipeline_runs: "max_pipeline_runs_per_day",
};

/** Mapping from a `usage_events.event_type` to the daily-counter dimension. */
const EVENT_TYPE_FOR_DAILY: Partial<Record<QuotaDimension, string>> = {
  api_calls: "api.call",
  pipeline_runs: "pipeline.run",
  storage_bytes: "storage.write",
};

/** A single dimension's effective limit + the source. */
export interface ResolvedLimit {
  field: QuotaField;
  value: number;
  /** "tier" if the value comes from `tenant_quotas`, "override" otherwise. */
  source: "tier" | "override";
  /** When `source = "override"`, the override row that won. */
  override?: QuotaOverrideEntity;
}

export interface CheckResult {
  ok: boolean;
  /** Number of units already consumed in the relevant window (day / total). */
  used: number;
  /** Effective limit (tier default or override). */
  limit: number;
  /** True when the limit is honored (`ok=true` does not imply infinite). */
  remaining: number;
  /** "tier" / "override" / "unknown" (open-fail). */
  source: "tier" | "override" | "unknown";
}

export interface CheckOptions {
  tenantId: string;
  dimension: QuotaDimension;
  /**
   * How many units this request would consume. Default 1. For
   * `storage_bytes` callers should pass the byte count.
   */
  increment?: number;
  /** Override the clock for tests. */
  now?: number;
}

export class QuotaService {
  /** Per-(tenant) cache of resolved tier+overrides. Invalidated on writes. */
  private readonly tenantCache = new Map<string, { quota: TenantQuotaEntity; overrides: QuotaOverrideEntity[]; expiresAt: number }>();
  /** Cache TTL — short enough that admin tier changes propagate, long enough to dedupe burst checks. */
  private readonly cacheTtlMs = 5_000;

  constructor(
    private readonly quotaRepo: TenantQuotaRepository,
    private readonly usageMeter: UsageMeterService,
    private readonly logger: Logger,
  ) {}

  /** Drop the cache for a tenant — call after admin tier/override writes. */
  invalidate(tenantId: string): void {
    this.tenantCache.delete(tenantId);
  }

  /**
   * Resolve the current tier row + active overrides for a tenant. Auto-seeds
   * a free-tier row on first access so single-tenant deployments don't have
   * to remember to bootstrap. Caller is responsible for handling errors —
   * `check()` calls this in a try/catch.
   */
  async resolveTenant(tenantId: string, now: number = Date.now()): Promise<{ quota: TenantQuotaEntity; overrides: QuotaOverrideEntity[] }> {
    const cached = this.tenantCache.get(tenantId);
    if (cached && cached.expiresAt > now) {
      return { quota: cached.quota, overrides: cached.overrides };
    }
    const quota = await this.quotaRepo.ensureSeeded(tenantId, "free");
    const overrides = this.quotaRepo.listActiveOverrides(tenantId, now);
    this.tenantCache.set(tenantId, { quota, overrides, expiresAt: now + this.cacheTtlMs });
    return { quota, overrides };
  }

  /** Resolve a single field's effective value (override wins over tier). */
  async resolveLimit(tenantId: string, field: QuotaField, now: number = Date.now()): Promise<ResolvedLimit> {
    const { quota, overrides } = await this.resolveTenant(tenantId, now);
    const matching = overrides.find(o => o.fieldName === field);
    if (matching) {
      return { field, value: matching.overrideValue, source: "override", override: matching };
    }
    return { field, value: quotaValueOf(quota, field), source: "tier" };
  }

  /**
   * Check if `dimension` would still be within budget after `increment`
   * additional units. Fail-open: any error returns `{ ok: true }` with
   * `source: "unknown"`. Caller is responsible for emitting a 429 when
   * `ok: false`.
   */
  async check(opts: CheckOptions): Promise<CheckResult> {
    const tenantId = opts.tenantId || DEFAULT_TENANT_ID;
    const dimension = opts.dimension;
    const increment = opts.increment ?? 1;
    const now = opts.now ?? Date.now();
    try {
      const field = DIMENSION_TO_FIELD[dimension];
      const resolved = await this.resolveLimit(tenantId, field, now);
      const used = this.measureUsage(tenantId, dimension, now);
      const projected = used + increment;
      return {
        ok: projected <= resolved.value,
        used,
        limit: resolved.value,
        remaining: Math.max(0, resolved.value - used),
        source: resolved.source,
      };
    } catch (err) {
      // Fail-open: a metering / quota lookup failure must not prevent the
      // request from succeeding. `source: "unknown"` lets observers see
      // the open-fail in metrics / logs.
      this.logger.warn({ err, tenantId, dimension }, "Quota check failed (fail-open)");
      return { ok: true, used: 0, limit: Number.POSITIVE_INFINITY, remaining: Number.POSITIVE_INFINITY, source: "unknown" };
    }
  }

  /**
   * Read current usage for a dimension. `users` and `skills` are point-in-
   * time counts handled by the caller (admin can pass a value via the
   * future `recordCount`); for now we return 0 for those — the daily
   * counters are the real product surface.
   *
   * Daily counters: sum `usage_events.quantity` from start-of-UTC-day to
   * end-of-UTC-day for the matching event_type.
   */
  private measureUsage(tenantId: string, dimension: QuotaDimension, now: number): number {
    const eventType = EVENT_TYPE_FOR_DAILY[dimension];
    if (!eventType) {
      // `users` / `skills` are static counts; the caller does the
      // measurement. Return 0 to mean "I don't know — defer to the
      // caller's `usedOverride`" once that is wired in. Today admin
      // REST CRUD checks against this 0 as a soft signal only.
      return 0;
    }
    // Day window in UTC. Hour-bucket strings sort lexicographically,
    // so a >= "YYYY-MM-DDT00" / <= "YYYY-MM-DDT23" range is exactly
    // the calendar UTC day.
    const dayPrefix = hourBucketOf(now).slice(0, 10); // "YYYY-MM-DD"
    return this.usageMeter.sumQuantity({
      tenantId,
      eventType,
      fromBucket: `${dayPrefix}T00`,
      toBucket: `${dayPrefix}T23`,
    });
  }
}

function quotaValueOf(q: TenantQuotaEntity, field: QuotaField): number {
  switch (field) {
    case "max_users": return q.maxUsers;
    case "max_skills": return q.maxSkills;
    case "max_storage_bytes": return q.maxStorageBytes;
    case "max_api_calls_per_day": return q.maxApiCallsPerDay;
    case "max_pipeline_runs_per_day": return q.maxPipelineRunsPerDay;
  }
}
