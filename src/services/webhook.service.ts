import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import type {
  WebhookRepository,
  WebhookEntity,
  WebhookEventType,
  CreateWebhookInput,
  UpdateWebhookInput,
} from "../db/repositories/webhook.repository.js";
import { VALID_WEBHOOK_EVENT_TYPES } from "../db/repositories/webhook.repository.js";
import type { WebhookDeliveryRepository, WebhookDeliveryEntity } from "../db/repositories/webhook-delivery.repository.js";
import { AppError, BadRequestError } from "../utils/errors.js";

// P1-16 — WebhookService (review §5.5.1).
//
// Surface:
//   • CRUD wrappers around `WebhookRepository` with URL/event validation.
//   • `publishEvent(eventType, tenantId, data)` — fire-and-forget; finds all
//     enabled subscriptions for the tenant matching the event type and
//     enqueues a `webhook_deliveries` row each. Caller doesn't wait for HTTP.
//   • `signRequest(secret, body, ts)` — produces the HMAC header value
//     `t=<unix>,v1=<hex>` per §5.5.1 (clients verify against `<ts>.<body>`).
//   • `verifySignature(...)` — exposed for symmetry; we don't currently
//     receive webhooks, but tests use it to assert signing correctness.
//
// SSRF guard:
//   • In production (`SKILL_MCP_WEBHOOK_ALLOW_PLAINTEXT` unset), URL must be
//     `https:` and the hostname must not be an obviously private/loopback
//     literal. We do a hostname-shape check (no DNS resolve at validation
//     time — that's deferred to dispatch where we honour `SKILL_MCP_WEBHOOK_*`
//     allowlist if set).
//   • In dev, plaintext + localhost are accepted for testing.

export const SIGNATURE_HEADER = "X-Skill-MCP-Signature";
export const DELIVERY_ID_HEADER = "X-Skill-MCP-Delivery-Id";

const PRIVATE_HOST_LITERALS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]",
]);

function isPrivateIPv4Octets(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  return false;
}

export interface WebhookServiceOptions {
  /**
   * When true, accept http:// URLs and hosts pointing at private/loopback
   * literals. Intended for local development and integration tests; never
   * enable in production. Defaults to false.
   */
  allowPlaintext?: boolean;
}

export class WebhookService {
  constructor(
    private readonly webhookRepo: WebhookRepository,
    private readonly deliveryRepo: WebhookDeliveryRepository,
    private readonly logger: Logger,
    private readonly opts: WebhookServiceOptions = {},
  ) {}

  // --- URL & input validation ---------------------------------------------

  /**
   * Throws `BadRequestError` if URL is invalid for the current mode.
   * Returns the parsed URL on success.
   */
  validateUrl(rawUrl: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BadRequestError("url must be a valid URL");
    }
    const allowPlain = this.opts.allowPlaintext === true;
    if (!allowPlain && parsed.protocol !== "https:") {
      throw new BadRequestError("url must use https:// (set SKILL_MCP_WEBHOOK_ALLOW_PLAINTEXT=true for dev)");
    }
    if (allowPlain && parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new BadRequestError("url must use http:// or https://");
    }
    const host = parsed.hostname.toLowerCase();
    if (!allowPlain) {
      if (PRIVATE_HOST_LITERALS.has(host)) {
        throw new BadRequestError(`url host "${host}" is not allowed (loopback / link-local)`);
      }
      if (isPrivateIPv4Octets(host)) {
        throw new BadRequestError(`url host "${host}" is a private IP literal`);
      }
      // Bracketed IPv6 loopback / link-local quick checks; full IPv6 parsing
      // would need a dedicated dep — at minimum reject the obvious literals.
      if (host.startsWith("fc") || host.startsWith("fd") || host === "::") {
        throw new BadRequestError(`url host "${host}" looks like a private IPv6`);
      }
    }
    return parsed;
  }

  validateEventTypes(raw: unknown): WebhookEventType[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new BadRequestError("event_types must be a non-empty array");
    }
    const out: WebhookEventType[] = [];
    for (const item of raw) {
      if (typeof item !== "string" || !VALID_WEBHOOK_EVENT_TYPES.has(item as WebhookEventType)) {
        throw new BadRequestError(`event_types contains an unknown type: ${item}`);
      }
      out.push(item as WebhookEventType);
    }
    return [...new Set(out)];
  }

  // --- CRUD ---------------------------------------------------------------

  create(input: { tenantId: string; url: string; eventTypes: unknown; description?: string | null }): WebhookEntity {
    this.validateUrl(input.url);
    const eventTypes = this.validateEventTypes(input.eventTypes);
    const payload: CreateWebhookInput = {
      tenantId: input.tenantId,
      url: input.url,
      eventTypes,
      description: input.description ?? null,
    };
    return this.webhookRepo.create(payload);
  }

  update(id: string, patch: { url?: string; eventTypes?: unknown; enabled?: boolean; description?: string | null }): WebhookEntity {
    const next: UpdateWebhookInput = {};
    if (patch.url !== undefined) {
      this.validateUrl(patch.url);
      next.url = patch.url;
    }
    if (patch.eventTypes !== undefined) {
      next.eventTypes = this.validateEventTypes(patch.eventTypes);
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.description !== undefined) next.description = patch.description;
    const result = this.webhookRepo.update(id, next);
    if (!result) throw new WebhookNotFoundError();
    return result;
  }

  rotateSecret(id: string): WebhookEntity {
    const result = this.webhookRepo.rotateSecret(id);
    if (!result) throw new WebhookNotFoundError();
    return result;
  }

  delete(id: string): void {
    if (!this.webhookRepo.delete(id)) throw new WebhookNotFoundError();
  }

  findById(id: string): WebhookEntity | null {
    return this.webhookRepo.findById(id);
  }

  listByTenant(tenantId: string): WebhookEntity[] {
    return this.webhookRepo.listByTenant(tenantId);
  }

  // --- Event fan-out ------------------------------------------------------

  /**
   * Build the canonical webhook payload (review §5.5.1) and enqueue one
   * `webhook_deliveries` row per matching subscription. Fire-and-forget: any
   * error logs at warn and is swallowed so producers (importer, pipeline
   * executor, user repo) never break.
   *
   * Returns the IDs of enqueued delivery rows (mostly useful for tests).
   */
  publishEvent(
    eventType: WebhookEventType,
    tenantId: string,
    data: Record<string, unknown>,
  ): string[] {
    try {
      const subscriptions = this.webhookRepo.listEnabledForEvent(tenantId, eventType);
      if (subscriptions.length === 0) return [];
      const eventId = `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      const createdAt = new Date().toISOString();
      const enqueued: string[] = [];
      for (const sub of subscriptions) {
        const payload = {
          id: eventId,
          type: eventType,
          created_at: createdAt,
          tenant_id: tenantId,
          data,
        };
        try {
          const delivery = this.deliveryRepo.enqueue({
            webhookId: sub.id,
            tenantId,
            eventType,
            payload: JSON.stringify(payload),
          });
          enqueued.push(delivery.id);
        } catch (err) {
          this.logger.warn({ err, webhookId: sub.id, eventType }, "Failed to enqueue webhook delivery");
        }
      }
      return enqueued;
    } catch (err) {
      this.logger.warn({ err, eventType, tenantId }, "publishEvent failed");
      return [];
    }
  }

  // --- HMAC signing -------------------------------------------------------

  /**
   * Compute the `X-Skill-MCP-Signature` header value for a payload.
   * Format: `t=<unix>,v1=<hex>` over `<unix>.<body>`.
   * Caller supplies the raw body string (must be byte-identical to what
   * goes on the wire) and the timestamp.
   */
  signRequest(secret: string, body: string, unixTs: number): string {
    const v1 = createHmac("sha256", secret)
      .update(`${unixTs}.${body}`)
      .digest("hex");
    return `t=${unixTs},v1=${v1}`;
  }

  /**
   * Constant-time signature verification with a 5-minute window. Used by
   * tests; production webhooks are outbound-only.
   */
  verifySignature(secret: string, body: string, header: string, now: number = Date.now()): boolean {
    const tsMatch = /t=(\d+)/.exec(header);
    const sigMatch = /v1=([a-f0-9]+)/.exec(header);
    if (!tsMatch || !sigMatch) return false;
    const ts = parseInt(tsMatch[1], 10);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(now / 1000 - ts) > 300) return false; // 5-minute skew
    const expected = createHmac("sha256", secret)
      .update(`${ts}.${body}`)
      .digest("hex");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(sigMatch[1], "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // --- Convenience for dispatcher / worker --------------------------------

  /** Look up the webhook owning a delivery (for signing). */
  findWebhookForDelivery(delivery: WebhookDeliveryEntity): WebhookEntity | null {
    return this.webhookRepo.findById(delivery.webhookId);
  }
}

export class WebhookNotFoundError extends AppError {
  constructor() {
    super("Webhook not found", "WEBHOOK_NOT_FOUND", 404);
    this.name = "WebhookNotFoundError";
  }
}
