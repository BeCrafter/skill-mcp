import type { DomainEventBus } from "./event-bus.js";
import type { WebhookService } from "../services/webhook.service.js";
import { DEFAULT_TENANT_ID } from "../types/index.js";

// P1-16 — bridge DomainEventBus → WebhookService.publishEvent. Keeps the
// producer call sites unaware of webhooks; new event types are added here.
export function setupWebhookSubscribers(bus: DomainEventBus, webhookService: WebhookService): void {
  bus.on("skill:imported", (event) => {
    webhookService.publishEvent("skill.published", event.tenantId ?? DEFAULT_TENANT_ID, {
      slug: event.slug,
      name: event.name,
      version: event.version,
      action: event.action,
      visibility: event.visibility,
      tags: event.tags,
    });
  });

  bus.on("skill:deprecated", (event) => {
    webhookService.publishEvent("skill.deprecated", event.tenantId ?? DEFAULT_TENANT_ID, {
      slug: event.slug,
      version: event.version,
      visibility: event.visibility,
      tags: event.tags,
    });
  });

  bus.on("pipeline:completed", (event) => {
    webhookService.publishEvent("pipeline.completed", event.tenantId ?? DEFAULT_TENANT_ID, {
      run_id: event.runId,
      pipeline_name: event.pipelineName,
      status: event.status,
      stage_count: event.stageCount,
    });
  });

  bus.on("user:token_rotated", (event) => {
    webhookService.publishEvent("user.token_rotated", event.tenantId, {
      user_id: event.userId,
      rotated_at: event.rotatedAt,
      previous_token_expires_at: event.previousTokenExpiresAt ?? null,
    });
  });
}
