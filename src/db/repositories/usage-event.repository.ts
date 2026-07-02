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
  userId: string | null;
  eventType: string;
  resourceId: string | null;
  quantity: number;
  metadata: Record<string, unknown> | null;
  hourBucket: string;
  createdAt: number;
}

export interface UsageEventCreate {
  userId?: string | null;
  eventType: string;
  resourceId?: string | null;
  quantity?: number;
  metadata?: Record<string, unknown> | null;
  createdAt?: number;
}

export interface AggregateRow {
  eventType: string;
  hourBucket: string;
  totalQuantity: number;
  eventCount: number;
}

export interface AggregateOptions {
  fromBucket?: string;
  toBucket?: string;
  eventType?: string;
}

export interface ListOptions {
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


export class UsageEventRepository {
  constructor(private db: DrizzleDB) {}

  async create(input: UsageEventCreate): Promise<UsageEventEntity> {
    const id = await generateUniqueId(() => shortId(), async (id) => {
      const row = this.db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.id, id)).get();
      return !!row;
    });
    const createdAt = input.createdAt ?? Date.now();
    const hb = hourBucketOf(createdAt);
    const qty = input.quantity ?? 1;
    this.db.insert(usageEvents).values({
      id, userId: input.userId ?? null, eventType: input.eventType,
      resourceId: input.resourceId ?? null, quantity: qty,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      hourBucket: hb, createdAt,
    }).run();
    return { id, userId: input.userId ?? null, eventType: input.eventType,
      resourceId: input.resourceId ?? null, quantity: qty,
      metadata: input.metadata ?? null, hourBucket: hb, createdAt };
  }

  createMany(inputs: UsageEventCreate[]): number {
    if (inputs.length === 0) return 0;
    this.db.insert(usageEvents).values(inputs.map(input => {
      const createdAt = input.createdAt ?? Date.now();
      return {
        id: shortId(), userId: input.userId ?? null, eventType: input.eventType,
        resourceId: input.resourceId ?? null, quantity: input.quantity ?? 1,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        hourBucket: hourBucketOf(createdAt), createdAt,
      };
    })).run();
    return inputs.length;
  }

  aggregate(opts: AggregateOptions): AggregateRow[] {
    const rows = this.db.select({
      eventType: usageEvents.eventType, hourBucket: usageEvents.hourBucket,
      totalQuantity: sql<number>`SUM(${usageEvents.quantity})`,
      eventCount: sql<number>`COUNT(*)`,
    }).from(usageEvents).where(this.buildConds(opts))
      .groupBy(usageEvents.eventType, usageEvents.hourBucket)
      .orderBy(usageEvents.hourBucket, usageEvents.eventType).all();
    return rows.map(r => ({ eventType: r.eventType, hourBucket: r.hourBucket,
      totalQuantity: Number(r.totalQuantity ?? 0), eventCount: Number(r.eventCount ?? 0) }));
  }

  sumQuantity(opts: AggregateOptions): number {
    const row = this.db.select({ total: sql<number>`COALESCE(SUM(${usageEvents.quantity}),0)` })
      .from(usageEvents).where(this.buildConds(opts)).all()[0];
    return Number(row?.total ?? 0);
  }

  list(opts: ListOptions): UsageEventEntity[] {
    const limit = Math.min(10000, Math.max(1, opts.limit ?? 1000));
    const rows = this.db.select().from(usageEvents).where(this.buildConds(opts))
      .orderBy(desc(usageEvents.createdAt)).limit(limit).all();
    return rows.map(r => this.toEntity(r));
  }

  deleteOlderThan(cutoffMs: number): number {
    const result = this.db.delete(usageEvents).where(lt(usageEvents.createdAt, cutoffMs)).run();
    return result.changes ?? 0;
  }

  private buildConds(opts: AggregateOptions) {
    const conds = [];
    if (opts.fromBucket) conds.push(gte(usageEvents.hourBucket, opts.fromBucket));
    if (opts.toBucket) conds.push(lte(usageEvents.hourBucket, opts.toBucket));
    if (opts.eventType) conds.push(eq(usageEvents.eventType, opts.eventType));
    return conds.length > 0 ? and(...conds) : undefined;
  }

  private toEntity(row: typeof usageEvents.$inferSelect): UsageEventEntity {
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata) {
      try {
        const p = JSON.parse(row.metadata as string);
        if (p && typeof p === "object" && !Array.isArray(p)) metadata = p as Record<string, unknown>;
      } catch { /* corrupt */ }
    }
    return { id: row.id, userId: row.userId ?? null, eventType: row.eventType,
      resourceId: row.resourceId ?? null, quantity: row.quantity, metadata,
      hourBucket: row.hourBucket, createdAt: row.createdAt };
  }
}

