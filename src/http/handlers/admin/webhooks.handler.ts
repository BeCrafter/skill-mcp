import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import type { HttpContext } from "../../context.js";
import { json, readJsonBody } from "../../helpers.js";
import { BadRequestError, AppError } from "../../../utils/errors.js";
import type { WebhookEntity } from "../../../db/repositories/webhook.repository.js";
import type { WebhookDeliveryEntity } from "../../../db/repositories/webhook-delivery.repository.js";
import { requireSuperadmin } from "../../middleware/admin-auth.js";

// P1-16 — Admin webhook CRUD + delivery audit + replay (review §5.5.1).
//
// Surface:
//   GET    /api/admin/webhooks                              — list (secret hidden)
//   POST   /api/admin/webhooks                              — create (secret returned ONCE)
//   GET    /api/admin/webhooks/:id                          — detail (secret hidden)
//   PUT    /api/admin/webhooks/:id                          — update (url/event_types/enabled/description)
//   POST   /api/admin/webhooks/:id/rotate                   — rotate secret (returned ONCE)
//   DELETE /api/admin/webhooks/:id                          — delete subscription (and orphan deliveries via cascade)
//   GET    /api/admin/webhooks/:id/deliveries               — last N deliveries for audit
//   POST   /api/admin/webhook-deliveries/:id/replay         — re-queue a dead-lettered delivery

class WebhookNotFoundHttpError extends AppError {
  constructor() { super("Webhook not found", "WEBHOOK_NOT_FOUND", 404); this.name = "WebhookNotFoundHttpError"; }
}

class DeliveryNotFoundError extends AppError {
  constructor() { super("Delivery not found", "DELIVERY_NOT_FOUND", 404); this.name = "DeliveryNotFoundError"; }
}

function requireWebhookId(value: string | undefined): string {
  if (!value || value.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new BadRequestError("Invalid webhook id");
  }
  return value;
}

function webhookToJson(w: WebhookEntity, includeSecret: boolean): Record<string, unknown> {
  return {
    id: w.id,
    url: w.url,
    event_types: w.eventTypes,
    enabled: w.enabled,
    description: w.description,
    created_at: w.createdAt,
    updated_at: w.updatedAt,
    secret_rotated_at: w.secretRotatedAt,
    ...(includeSecret ? { secret: w.secret } : {}),
  };
}

function deliveryToJson(d: WebhookDeliveryEntity): Record<string, unknown> {
  return {
    id: d.id,
    webhook_id: d.webhookId,
    event_type: d.eventType,
    delivery_id: d.deliveryId,
    payload: d.payload,
    attempt: d.attempt,
    status: d.status,
    response_status: d.responseStatus,
    response_body: d.responseBody,
    error_message: d.errorMessage,
    next_retry_at: d.nextRetryAt,
    first_attempted_at: d.firstAttemptedAt,
    last_attempted_at: d.lastAttemptedAt,
    completed_at: d.completedAt,
    created_at: d.createdAt,
  };
}

interface PostWebhookBody {
  url?: string;
  event_types?: unknown;
  description?: string | null;
}

interface PatchWebhookBody {
  url?: string;
  event_types?: unknown;
  enabled?: boolean;
  description?: string | null;
}

export function registerAdminWebhookRoutes(router: Router, deps: AppDependencies): void {
  if (!deps.webhookService || !deps.webhookRepo || !deps.webhookDeliveryRepo) return;
  const { webhookService, webhookRepo, webhookDeliveryRepo } = deps;
  const tenantId = (ctx: HttpContext) => ctx.requestContext?.tenantId ?? "default";

  router.get("/api/admin/webhooks", async (ctx) => {
    const rows = webhookRepo.listByTenant(tenantId(ctx));
    json(ctx.res, 200, {
      success: true,
      data: rows.map((w) => webhookToJson(w, false)),
      total: rows.length,
    });
  });

  router.post("/api/admin/webhooks", async (ctx) => {
    requireSuperadmin(ctx.requestContext!);
    const tid = tenantId(ctx);
    const data = await readJsonBody<PostWebhookBody>(ctx.req);
    if (typeof data.url !== "string") throw new BadRequestError("url is required");
    const w = await webhookService.create({
      tenantId: tid,
      url: data.url,
      eventTypes: data.event_types,
      description: data.description ?? null,
    });
    json(ctx.res, 201, { success: true, data: webhookToJson(w, true) });
  });

  router.get("/api/admin/webhooks/:id", async (ctx) => {
    const id = requireWebhookId(ctx.params.id);
    const w = webhookService.findById(id);
    if (!w) throw new WebhookNotFoundHttpError();
    json(ctx.res, 200, { success: true, data: webhookToJson(w, false) });
  });

  router.put("/api/admin/webhooks/:id", async (ctx) => {
    requireSuperadmin(ctx.requestContext!);
    const id = requireWebhookId(ctx.params.id);
    const data = await readJsonBody<PatchWebhookBody>(ctx.req);
    const updated = webhookService.update(id, {
      url: data.url,
      eventTypes: data.event_types,
      enabled: data.enabled,
      description: data.description,
    });
    json(ctx.res, 200, { success: true, data: webhookToJson(updated, false) });
  });

  router.post("/api/admin/webhooks/:id/rotate", async (ctx) => {
    requireSuperadmin(ctx.requestContext!);
    const id = requireWebhookId(ctx.params.id);
    const w = webhookService.rotateSecret(id);
    json(ctx.res, 200, { success: true, data: webhookToJson(w, true) });
  });

  router.delete("/api/admin/webhooks/:id", async (ctx) => {
    requireSuperadmin(ctx.requestContext!);
    const id = requireWebhookId(ctx.params.id);
    webhookService.delete(id);
    json(ctx.res, 200, { success: true });
  });

  router.get("/api/admin/webhooks/:id/deliveries", async (ctx) => {
    const id = requireWebhookId(ctx.params.id);
    const limit = Math.min(parseInt(ctx.query.get("limit") ?? "50", 10) || 50, 500);
    const rows = webhookDeliveryRepo.listByWebhook(id, limit);
    json(ctx.res, 200, {
      success: true,
      data: rows.map(deliveryToJson),
      total: rows.length,
    });
  });

  router.post("/api/admin/webhook-deliveries/:id/replay", async (ctx) => {
    requireSuperadmin(ctx.requestContext!);
    const id = ctx.params.id;
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new BadRequestError("Invalid delivery id");
    const existing = webhookDeliveryRepo.findById(id);
    if (!existing) throw new DeliveryNotFoundError();
    const replayed = webhookDeliveryRepo.reschedule(id);
    if (!replayed) throw new DeliveryNotFoundError();
    json(ctx.res, 202, { success: true, data: deliveryToJson(replayed) });
  });
}
