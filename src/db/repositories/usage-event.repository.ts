import { and, eq, gte, lte, lt, desc, sql } from "drizzle-orm";
import { shortId, generateUniqueId } from "../../utils/id.js";
import type { DrizzleDB } from "../connection.js";
import { usageEvents } from "../schema.js";

// P1-13 — Usage metering data layer (review §9.1).
//
// `event_type` is intentionally kept as free-form text (rather than an enum)
// so future event types — `embedding.search`, `webhook.delivered`, etc. —
// don't require a schema bump. The four canonical types in v1 are:
//   • `skill.view`   — gateway / MCP `skill_view` call
//   • `pipeline.run` — completed pipeline (`quantity` = stage count)
//   • `api.call`     — generic HTTP request count (rate-limit/billing input)
//   • `storage.write`— bytes written by importer / rollback (`quantity` = bytes)
export type CanonicalEventType =
  | "skill.view"
  | "pipeline.run"
  | "api.call"
  | "storage.write";

export interface UsageEventEntity {
  id: string;
  tenantId: string;
  userId: string | null;
  eventType: string;
  resourceId: string | null;
  quantity: number;
  metadata: Record<string, unknown> | null;
  hourBucket: string;
  createdAt: number;
}

export interface UsageEventCreate {
  tenantId: string;
  userId?: string | null;
  eventType: string;
  resourceId?: string | null;
  quantity?: number;
  metadata?: Record<string, unknown> | null;
  /** Override timestamp (epoch ms). Defaults to `Date.now()`. */
  createdAt?: number;
}

export interface AggregateRow {
  tenantId: string;
  eventType: string;
  hourBucket: string;
  totalQuantity: number;
  eventCount: number;
}

export interface AggregateOptions {
  tenantId: string;
  /** Start of range (inclusive) as hour bucket string `"YYYY-MM-DDTHH"`. */
  fromBucket?: string;
  /** End of range (inclusive). */
  toBucket?: string;
  /** Restrict to a single event type. */
  eventType?: string;
}

export interface ListOptions {
  tenantId: string;
  eventType?: string;
  /** Lower-bound on hour_bucket (inclusive). */
  fromBucket?: string;
  toBucket?: string;
  limit?: number;
}

/**
 * Compute the UTC hour bucket string for an epoch-ms timestamp. Format
 * `"YYYY-MM-DDTHH"` matches the §9.1 schema example. Centralised here so
 * callers (service / aggregator / tests) cannot drift on padding rules.
 */
export function hourBucketOf(ts: number): string {
  if (!Number.isFinite(ts)) return "unknown";
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}`;
}

export class UsageEventRepository {
  constructor(private db: DrizzleDB) {}

  /**
   * Append a single event. Synchronous from SQLite's perspective; callers
   * who need fire-and-forget semantics (hot path) should use
   * `UsageMeterService.record()` which wraps this in a `setImmediate` +
   * try/catch.
   */
  async create(input: UsageEventCreate): Promise<UsageEventEntity> {
    const id = await generateUniqueId(() => shortId(), async (id) => {
      const row = this.db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.id, id)).get();
      return !!row;
    });
    const createdAt = input.createdAt ?? Date.now();
    const hourBucket = hourBucketOf(createdAt);
    const quantity = input.quantity ?? 1;
    this.db.insert(usageEvents).values({
      id,
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      eventType: input.eventType,
      resourceId: input.resourceId ?? null,
      quantity,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      hourBucket,
      createdAt,
    }).run();
    return {
      id,
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      eventType: input.eventType,
      resourceId: input.resourceId ?? null,
      quantity,
      metadata: input.metadata ?? null,
      hourBucket,
      createdAt,
    };
  }

  /**
   * Bulk insert in a single transaction. Used by the (future) Redis →
   * SQLite hourly archiver. Empty input is a no-op.
   */
  createMany(inputs: UsageEventCreate[]): number {
    if (inputs.length === 0) return 0;
    const rows = inputs.map(input => {
      const createdAt = input.createdAt ?? Date.now();
      return {
        id: shortId(),
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        eventType: input.eventType,
        resourceId: input.resourceId ?? null,
        quantity: input.quantity ?? 1,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        hourBucket: hourBucketOf(createdAt),
        createdAt,
      };
    });
    this.db.insert(usageEvents).values(rows).run();
    return rows.length;
  }

  /**
   * Sum `quantity` and count rows grouped by `(tenant, event_type, hour_bucket)`.
   * Hits `idx_usage_events_tenant_event` when `eventType` is set, otherwise
   * `idx_usage_events_tenant_bucket`. Both are covering for this query.
   */
  aggregate(opts: AggregateOptions): AggregateRow[] {
    const conditions = [eq(usageEvents.tenantId, opts.tenantId)];
    if (opts.fromBucket) conditions.push(gte(usageEvents.hourBucket, opts.fromBucket));
    if (opts.toBucket) conditions.push(lte(usageEvents.hourBucket, opts.toBucket));
    if (opts.eventType) conditions.push(eq(usageEvents.eventType, opts.eventType));
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);
    const rows = this.db
      .select({
        tenantId: usageEvents.tenantId,
        eventType: usageEvents.eventType,
        hourBucket: usageEvents.hourBucket,
        totalQuantity: sql<number>`SUM(${usageEvents.quantity})`,
        eventCount: sql<number>`COUNT(*)`,
      })
      .from(usageEvents)
      .where(where)
      .groupBy(usageEvents.tenantId, usageEvents.eventType, usageEvents.hourBucket)
      .orderBy(usageEvents.hourBucket, usageEvents.eventType)
      .all();
    return rows.map(r => ({
      tenantId: r.tenantId,
      eventType: r.eventType,
      hourBucket: r.hourBucket,
      totalQuantity: Number(r.totalQuantity ?? 0),
      eventCount: Number(r.eventCount ?? 0),
    }));
  }

  /**
   * Sum `quantity` for a single (tenant, event_type, range) — used by the
   * quota check hot path (item 17). Uses the same covering index as
   * aggregate(). Returns 0 when nothing matches (never throws).
   */
  sumQuantity(opts: AggregateOptions): number {
    const conditions = [eq(usageEvents.tenantId, opts.tenantId)];
    if (opts.fromBucket) conditions.push(gte(usageEvents.hourBucket, opts.fromBucket));
    if (opts.toBucket) conditions.push(lte(usageEvents.hourBucket, opts.toBucket));
    if (opts.eventType) conditions.push(eq(usageEvents.eventType, opts.eventType));
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);
    const row = this.db
      .select({ total: sql<number>`COALESCE(SUM(${usageEvents.quantity}), 0)` })
      .from(usageEvents)
      .where(where)
      .all()[0];
    return Number(row?.total ?? 0);
  }

  /** List raw events (admin debugging / CSV export). */
  list(opts: ListOptions): UsageEventEntity[] {
    const conditions = [eq(usageEvents.tenantId, opts.tenantId)];
    if (opts.eventType) conditions.push(eq(usageEvents.eventType, opts.eventType));
    if (opts.fromBucket) conditions.push(gte(usageEvents.hourBucket, opts.fromBucket));
    if (opts.toBucket) conditions.push(lte(usageEvents.hourBucket, opts.toBucket));
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);
    const limit = Math.min(10000, Math.max(1, opts.limit ?? 1000));
    const rows = this.db
      .select()
      .from(usageEvents)
      .where(where)
      .orderBy(desc(usageEvents.createdAt))
      .limit(limit)
      .all();
    return rows.map(r => this.toEntity(r));
  }

  /** Retention helper. Used by an admin CLI / cron to archive cold data. */
  deleteOlderThan(cutoffMs: number): number {
    const result = this.db
      .delete(usageEvents)
      .where(lt(usageEvents.createdAt, cutoffMs))
      .run();
    return result.changes ?? 0;
  }

  private toEntity(row: typeof usageEvents.$inferSelect): UsageEventEntity {
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata);
        // Same defensive parse pattern as access-log.repository (T-716):
        // a corrupt JSON cell must not 500 the listing.
        metadata = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      } catch {
        metadata = null;
      }
    }
    return {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId ?? null,
      eventType: row.eventType,
      resourceId: row.resourceId ?? null,
      quantity: row.quantity,
      metadata,
      hourBucket: row.hourBucket,
      createdAt: row.createdAt,
    };
  }
}
