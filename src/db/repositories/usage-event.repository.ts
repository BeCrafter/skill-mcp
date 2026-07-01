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
  tenantId?: string;
  userId?: string | null;
  eventType: string;
  resourceId?: string | null;
  quantity?: number;
  metadata?: Record<string, unknown> | null;
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
  fromBucket?: string;
  toBucket?: string;
  eventType?: string;
}

export interface ListOptions {
  tenantId: string;
  eventType?: string;
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
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}`;
}

const DEFAULT_TENANT = "default";

export class UsageEventRepository {
  constructor(private db: DrizzleDB) {}

  async create(input: UsageEventCreate): Promise<UsageEventEntity> {
    const id = await generateUniqueId(() => shortId(), async (id) => {
      const row = this.db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.id, id)).get();
      return !!row;
    });
    const createdAt = input.createdAt ?? Date.now();
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    const row = {
      id, tenantId, userId: input.userId ?? null, eventType: input.eventType,
      resourceId: input.resourceId ?? null, quantity: input.quantity ?? 1,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      hourBucket: hourBucketOf(createdAt), createdAt,
    };
    this.db.insert(usageEvents).values(row).run();
    return { ...row, metadata: input.metadata ?? null };
  }

  createMany(inputs: UsageEventCreate[]): number {
    if (inputs.length === 0) return 0;
    const now = Date.now();
    const rows = inputs.map(input => {
      const createdAt = input.createdAt ?? now;
      return {
        id: shortId(), tenantId: input.tenantId ?? DEFAULT_TENANT,
        userId: input.userId ?? null, eventType: input.eventType,
        resourceId: input.resourceId ?? null, quantity: input.quantity ?? 1,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        hourBucket: hourBucketOf(createdAt), createdAt,
      };
    });
    this.db.insert(usageEvents).values(rows).run();
    return rows.length;
  }

  aggregate(opts: AggregateOptions): AggregateRow[] {
    const w = this.buildWhere(opts);
    const rows = this.db.select({
      tenantId: usageEvents.tenantId, eventType: usageEvents.eventType,
      hourBucket: usageEvents.hourBucket,
      totalQuantity: sql<number>`SUM(${usageEvents.quantity})`,
      eventCount: sql<number>`COUNT(*)`,
    }).from(usageEvents).where(w)
      .groupBy(usageEvents.tenantId, usageEvents.eventType, usageEvents.hourBucket)
      .orderBy(usageEvents.hourBucket, usageEvents.eventType).all();
    return rows.map(r => ({
      tenantId: r.tenantId, eventType: r.eventType, hourBucket: r.hourBucket,
      totalQuantity: Number(r.totalQuantity ?? 0), eventCount: Number(r.eventCount ?? 0),
    }));
  }

  sumQuantity(opts: AggregateOptions): number {
    const w = this.buildWhere(opts);
    const row = this.db.select({ total: sql<number>`COALESCE(SUM(${usageEvents.quantity}), 0)` })
      .from(usageEvents).where(w).all()[0];
    return Number(row?.total ?? 0);
  }

  list(opts: ListOptions): UsageEventEntity[] {
    const w = this.buildWhere(opts);
    const limit = Math.min(10000, Math.max(1, opts.limit ?? 1000));
    const rows = this.db.select().from(usageEvents).where(w)
      .orderBy(desc(usageEvents.createdAt)).limit(limit).all();
    return rows.map(r => this.toEntity(r));
  }

  /** Retention helper. Used by an admin CLI / cron to archive cold data. */
  deleteOlderThan(cutoffMs: number): number {
    const result = this.db.delete(usageEvents).where(lt(usageEvents.createdAt, cutoffMs)).run();
    return result.changes ?? 0;
  }

  private buildWhere(opts: AggregateOptions) {
    const conds = [eq(usageEvents.tenantId, opts.tenantId)];
    if (opts.fromBucket) conds.push(gte(usageEvents.hourBucket, opts.fromBucket));
    if (opts.toBucket) conds.push(lte(usageEvents.hourBucket, opts.toBucket));
    if (opts.eventType) conds.push(eq(usageEvents.eventType, opts.eventType));
    return and(...conds);
  }

  private toEntity(row: typeof usageEvents.$inferSelect): UsageEventEntity {
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata as string);
        metadata = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown> : null;
      } catch { metadata = null; }
    }
    return {
      id: row.id, tenantId: row.tenantId, userId: row.userId ?? null,
      eventType: row.eventType, resourceId: row.resourceId ?? null,
      quantity: row.quantity, metadata, hourBucket: row.hourBucket, createdAt: row.createdAt,
    };
  }
}
