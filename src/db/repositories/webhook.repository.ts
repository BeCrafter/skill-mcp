import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { generateId, generateUniqueId } from "../../utils/id.js";
import type { DrizzleDB } from "../connection.js";
import { webhooks } from "../schema.js";

// P1-16 — Webhook subscriptions (review §5.5.1).
//
// One row per subscription endpoint. The `secret` column is HMAC material;
// it is shown to the caller exactly once (on POST), and `findById` /
// `listEnabledForEvent` callers DO get the secret in the entity (the
// dispatcher needs it to sign), but the admin handler strips it before
// serializing the response. Treat this as "do-not-log".
//
// `event_types` is JSON-serialised in the column. We expose it as
// `string[]` to callers and validate canonical names at the service layer.

export type WebhookEventType =
  | "skill.published"
  | "skill.deprecated"
  | "pipeline.completed"
  | "user.token_rotated"
  | "user.logged_in"
  | "user.password_changed";

export const VALID_WEBHOOK_EVENT_TYPES: ReadonlySet<WebhookEventType> = new Set([
  "skill.published",
  "skill.deprecated",
  "pipeline.completed",
  "user.token_rotated",
  "user.logged_in",
  "user.password_changed",
]);

export interface WebhookEntity {
  id: string;
  url: string;
  secret: string;
  eventTypes: WebhookEventType[];
  enabled: boolean;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  secretRotatedAt: number | null;
}

export interface CreateWebhookInput {
  url: string;
  eventTypes: WebhookEventType[];
  description?: string | null;
  /** If omitted, a random 32-byte hex secret is generated. */
  secret?: string;
}

export interface UpdateWebhookInput {
  url?: string;
  eventTypes?: WebhookEventType[];
  enabled?: boolean;
  description?: string | null;
}

export class WebhookRepository {
  constructor(private db: DrizzleDB) {}

  async create(input: CreateWebhookInput): Promise<WebhookEntity> {
    const id = await generateUniqueId(() => generateId("wh_"), async (id) => !!(await this.findById(id)));
    const now = Date.now();
    const secret = input.secret ?? randomBytes(32).toString("hex");
    const eventTypesJson = JSON.stringify(input.eventTypes);
    this.db.insert(webhooks).values({
      id,
      url: input.url,
      secret,
      eventTypes: eventTypesJson,
      enabled: 1,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
      secretRotatedAt: null,
    }).run();
    return {
      id,
      url: input.url,
      secret,
      eventTypes: input.eventTypes,
      enabled: true,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
      secretRotatedAt: null,
    };
  }

  findById(id: string): WebhookEntity | null {
    const row = this.db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1).all()[0];
    return row ? this.toEntity(row) : null;
  }

  listAll(): WebhookEntity[] {
    const rows = this.db.select().from(webhooks).all();
    return rows.map(r => this.toEntity(r));
  }

  /**
   * All enabled webhooks whose `event_types` JSON array contains the given
   * event. Returned in insertion order (id asc — sufficient since dispatch
   * order is not customer-visible).
   */
  listEnabledForEvent(eventType: WebhookEventType): WebhookEntity[] {
    const rows = this.db.select().from(webhooks)
      .where(eq(webhooks.enabled, 1))
      .all();
    return rows
      .map(r => this.toEntity(r))
      .filter(e => e.eventTypes.includes(eventType));
  }

  update(id: string, patch: UpdateWebhookInput): WebhookEntity | null {
    const existing = this.findById(id);
    if (!existing) return null;
    const next: Partial<typeof webhooks.$inferInsert> = { updatedAt: Date.now() };
    if (patch.url !== undefined) next.url = patch.url;
    if (patch.eventTypes !== undefined) next.eventTypes = JSON.stringify(patch.eventTypes);
    if (patch.enabled !== undefined) next.enabled = patch.enabled ? 1 : 0;
    if (patch.description !== undefined) next.description = patch.description;
    this.db.update(webhooks).set(next).where(eq(webhooks.id, id)).run();
    return this.findById(id);
  }

  /**
   * Replace `secret` with a fresh 32-byte hex string and stamp
   * `secret_rotated_at`. Returns the new entity (with the new secret) so the
   * admin handler can echo it once. The old secret is overwritten — there
   * is no double-key window in the SQLite default deployment.
   */
  rotateSecret(id: string): WebhookEntity | null {
    const existing = this.findById(id);
    if (!existing) return null;
    const newSecret = randomBytes(32).toString("hex");
    const now = Date.now();
    this.db.update(webhooks)
      .set({ secret: newSecret, secretRotatedAt: now, updatedAt: now })
      .where(eq(webhooks.id, id))
      .run();
    return { ...existing, secret: newSecret, secretRotatedAt: now, updatedAt: now };
  }

  delete(id: string): boolean {
    const result = this.db.delete(webhooks).where(eq(webhooks.id, id)).run();
    return (result.changes ?? 0) > 0;
  }

  private toEntity(row: typeof webhooks.$inferSelect): WebhookEntity {
    let eventTypes: WebhookEventType[] = [];
    try {
      const parsed = JSON.parse(row.eventTypes);
      if (Array.isArray(parsed)) eventTypes = parsed.filter((x): x is WebhookEventType => typeof x === "string");
    } catch { /* ignore corrupt JSON; treated as empty subscriptions */ }
    return {
      id: row.id,
      url: row.url,
      secret: row.secret,
      eventTypes,
      enabled: row.enabled === 1,
      description: row.description ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      secretRotatedAt: row.secretRotatedAt ?? null,
    };
  }
}
