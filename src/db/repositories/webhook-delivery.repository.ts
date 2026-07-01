import { and, eq, lte, asc, desc } from "drizzle-orm";
import { generateId, shortId, generateUniqueId } from "../../utils/id.js";
import type { DrizzleDB } from "../connection.js";
import { webhookDeliveries } from "../schema.js";

// P1-16 — Webhook delivery ledger + retry queue (review §5.5.1).
//
// One row per (webhook, event) pair. Subsequent retries UPDATE the same row
// so the `delivery_id` UUID stays stable for client idempotency. The worker
// polls `idx_webhook_deliveries_due` for `status='pending' AND next_retry_at <= now`.
//
// Statuses:
//   pending     — created or rescheduled; `next_retry_at` set
//   success     — 2xx received; `completed_at` set; `next_retry_at` cleared
//   failed      — last attempt failed but more attempts remain (transitional)
//   dead_letter — 8 attempts exhausted; admin replay flips back to pending

export type WebhookDeliveryStatus = "pending" | "success" | "failed" | "dead_letter";

export interface WebhookDeliveryEntity {
  id: string;
  webhookId: string;
  tenantId: string;
  eventType: string;
  deliveryId: string;
  payload: string;
  attempt: number;
  status: WebhookDeliveryStatus;
  responseStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  nextRetryAt: number | null;
  firstAttemptedAt: number | null;
  lastAttemptedAt: number | null;
  completedAt: number | null;
  createdAt: number;
}

export interface EnqueueDeliveryInput {
  webhookId: string;
  tenantId: string;
  eventType: string;
  payload: string;
  /** Override the auto-generated delivery_id (test-only). */
  deliveryId?: string;
  /** Override now (test-only). Defaults to Date.now(). */
  now?: number;
}

export interface RecordAttemptInput {
  id: string;
  attempt: number;
  status: WebhookDeliveryStatus;
  responseStatus?: number | null;
  responseBody?: string | null;
  errorMessage?: string | null;
  nextRetryAt?: number | null;
  now?: number;
}

export class WebhookDeliveryRepository {
  constructor(private db: DrizzleDB) {}

  /**
   * Insert a fresh `pending` row. `next_retry_at = now` so the worker picks
   * it up on the very next poll. Returns the row.
   */
  async enqueue(input: EnqueueDeliveryInput): Promise<WebhookDeliveryEntity> {
    const id = await generateUniqueId(() => shortId(), async (id) => !!(await this.findById(id)));
    const deliveryId = input.deliveryId ?? await generateUniqueId(() => generateId("dlv_"), async (id) => !!(await this.findById(id)));
    const now = input.now ?? Date.now();
    this.db.insert(webhookDeliveries).values({
      id,
      webhookId: input.webhookId,
      tenantId: input.tenantId,
      eventType: input.eventType,
      deliveryId,
      payload: input.payload,
      attempt: 0,
      status: "pending",
      responseStatus: null,
      responseBody: null,
      errorMessage: null,
      nextRetryAt: now,
      firstAttemptedAt: null,
      lastAttemptedAt: null,
      completedAt: null,
      createdAt: now,
    }).run();
    return {
      id,
      webhookId: input.webhookId,
      tenantId: input.tenantId,
      eventType: input.eventType,
      deliveryId,
      payload: input.payload,
      attempt: 0,
      status: "pending",
      responseStatus: null,
      responseBody: null,
      errorMessage: null,
      nextRetryAt: now,
      firstAttemptedAt: null,
      lastAttemptedAt: null,
      completedAt: null,
      createdAt: now,
    };
  }

  /** Pick up at most `limit` rows that are due (status='pending', next_retry_at <= now). */
  listDue(now: number = Date.now(), limit: number = 32): WebhookDeliveryEntity[] {
    const rows = this.db.select().from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextRetryAt, now)))
      .orderBy(asc(webhookDeliveries.nextRetryAt))
      .limit(limit)
      .all();
    return rows.map(r => this.toEntity(r));
  }

  findById(id: string): WebhookDeliveryEntity | null {
    const row = this.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).limit(1).all()[0];
    return row ? this.toEntity(row) : null;
  }

  /**
   * Update a row after an attempt. Stamps `last_attempted_at = now`, fills
   * `first_attempted_at` if currently null, and writes `completed_at` if
   * status is terminal (`success` | `dead_letter`).
   */
  recordAttempt(input: RecordAttemptInput): WebhookDeliveryEntity | null {
    const existing = this.findById(input.id);
    if (!existing) return null;
    const now = input.now ?? Date.now();
    const next: Partial<typeof webhookDeliveries.$inferInsert> = {
      attempt: input.attempt,
      status: input.status,
      lastAttemptedAt: now,
      firstAttemptedAt: existing.firstAttemptedAt ?? now,
    };
    if (input.responseStatus !== undefined) next.responseStatus = input.responseStatus;
    if (input.responseBody !== undefined) next.responseBody = input.responseBody;
    if (input.errorMessage !== undefined) next.errorMessage = input.errorMessage;
    if (input.status === "pending" || input.status === "failed") {
      next.nextRetryAt = input.nextRetryAt ?? null;
    } else {
      // success or dead_letter — clear retry timer, stamp completion.
      next.nextRetryAt = null;
      next.completedAt = now;
    }
    this.db.update(webhookDeliveries).set(next).where(eq(webhookDeliveries.id, input.id)).run();
    return this.findById(input.id);
  }

  /**
   * Admin replay: take a row whose status is `dead_letter` (or `failed`) and
   * flip it back to `pending` with `next_retry_at = now`. Attempt counter is
   * preserved so audit shows the full history.
   */
  reschedule(id: string, now: number = Date.now()): WebhookDeliveryEntity | null {
    const existing = this.findById(id);
    if (!existing) return null;
    this.db.update(webhookDeliveries)
      .set({ status: "pending", nextRetryAt: now, completedAt: null })
      .where(eq(webhookDeliveries.id, id))
      .run();
    return this.findById(id);
  }

  listByWebhook(webhookId: string, limit: number = 100): WebhookDeliveryEntity[] {
    const rows = this.db.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit)
      .all();
    return rows.map(r => this.toEntity(r));
  }

  listByTenant(tenantId: string, limit: number = 100): WebhookDeliveryEntity[] {
    const rows = this.db.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.tenantId, tenantId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit)
      .all();
    return rows.map(r => this.toEntity(r));
  }


  /** Hard delete (admin / retention job). */
  delete(id: string): boolean {
    const result = this.db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, id)).run();
    return (result.changes ?? 0) > 0;
  }

  private toEntity(row: typeof webhookDeliveries.$inferSelect): WebhookDeliveryEntity {
    return {
      id: row.id,
      webhookId: row.webhookId,
      tenantId: row.tenantId,
      eventType: row.eventType,
      deliveryId: row.deliveryId,
      payload: row.payload,
      attempt: row.attempt,
      status: row.status as WebhookDeliveryStatus,
      responseStatus: row.responseStatus ?? null,
      responseBody: row.responseBody ?? null,
      errorMessage: row.errorMessage ?? null,
      nextRetryAt: row.nextRetryAt ?? null,
      firstAttemptedAt: row.firstAttemptedAt ?? null,
      lastAttemptedAt: row.lastAttemptedAt ?? null,
      completedAt: row.completedAt ?? null,
      createdAt: row.createdAt,
    };
  }
}
