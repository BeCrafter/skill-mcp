import type { Logger } from "pino";
import type { WebhookDeliveryRepository, WebhookDeliveryEntity } from "../db/repositories/webhook-delivery.repository.js";
import type { WebhookRepository } from "../db/repositories/webhook.repository.js";
import { WebhookService, SIGNATURE_HEADER, DELIVERY_ID_HEADER } from "./webhook.service.js";
import { metrics } from "../telemetry/metrics.js";

// P1-16 — WebhookDispatcher (review §5.5.1).
//
// One method (`dispatch`) per row pulled off the retry queue:
//   1. Sign the payload with the webhook's secret + a fresh unix-second ts.
//   2. POST to the URL with timeout(connect 10s, total 30s).
//   3. Inspect response — 2xx/3xx is success; 4xx (except 408/429) is a
//      permanent failure → dead_letter; 5xx / 408 / 429 / network = retry.
//   4. Compute the next backoff (`min(2^n + random[0,1], 600) * 1000` ms).
//      Cap at 8 attempts AND 24h-since-first-attempt — whichever first.
//
// `dispatchDue(now, limit)` is the loop entry point used by the worker.

const MAX_ATTEMPTS = 8;
const TOTAL_TIME_BUDGET_MS = 24 * 60 * 60 * 1000;
const MAX_BACKOFF_SEC = 600;
const HTTP_TIMEOUT_MS = 30_000;

/** Exponential backoff with jitter. Returns ms to wait before the next try. */
export function computeBackoffMs(attempt: number, jitterRand: () => number = Math.random): number {
  const exp = Math.min(2 ** attempt + jitterRand(), MAX_BACKOFF_SEC);
  return Math.floor(exp * 1000);
}

/**
 * Decide whether an HTTP status warrants a retry. Per §5.5.1:
 *   • 2xx / 3xx — success, no retry
 *   • 4xx (except 408 timeout, 429 too many requests) — permanent failure
 *   • 5xx / 408 / 429 — transient
 */
export function isRetryableStatus(status: number): boolean {
  if (status >= 200 && status < 400) return false;
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

export interface DispatchResult {
  delivery: WebhookDeliveryEntity;
  outcome: "success" | "retry_scheduled" | "dead_letter" | "abandoned" | "skipped";
}

export interface FetchLike {
  (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{
    status: number;
    text: () => Promise<string>;
  }>;
}

export interface WebhookDispatcherOptions {
  /** Inject a fetch implementation (defaults to global fetch). */
  fetchImpl?: FetchLike;
  /** Override the timeout for tests. */
  timeoutMs?: number;
  /** Override jitter source for deterministic tests. */
  jitterRand?: () => number;
  /** Override Date.now for deterministic tests. */
  now?: () => number;
}

export class WebhookDispatcher {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly jitterRand: () => number;
  private readonly now: () => number;

  constructor(
    private readonly webhookRepo: WebhookRepository,
    private readonly deliveryRepo: WebhookDeliveryRepository,
    private readonly webhookService: WebhookService,
    private readonly logger: Logger,
    opts: WebhookDispatcherOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit) as unknown as ReturnType<FetchLike>);
    this.timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
    this.jitterRand = opts.jitterRand ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Pull up to `limit` due rows and dispatch each. Returns the per-row
   * outcomes. Errors on a single row do not stop the batch.
   */
  async dispatchDue(limit: number = 32): Promise<DispatchResult[]> {
    const due = this.deliveryRepo.listDue(this.now(), limit);
    const results: DispatchResult[] = [];
    for (const delivery of due) {
      try {
        results.push(await this.dispatch(delivery));
      } catch (err) {
        this.logger.warn({ err, deliveryId: delivery.id }, "webhook dispatch threw unexpectedly");
        results.push({ delivery, outcome: "skipped" });
      }
    }
    return results;
  }

  /**
   * Dispatch a single delivery row. Returns the updated row and an outcome
   * label. Caller is responsible for telling the worker whether to keep
   * iterating.
   */
  async dispatch(delivery: WebhookDeliveryEntity): Promise<DispatchResult> {
    const webhook = this.webhookRepo.findById(delivery.webhookId);
    if (!webhook) {
      // Webhook deleted while a delivery was queued. Mark dead_letter so the
      // row stops appearing as `pending` and the admin can audit.
      this.logger.warn({ deliveryId: delivery.id, webhookId: delivery.webhookId }, "Webhook missing — dead-lettering");
      const updated = this.deliveryRepo.recordAttempt({
        id: delivery.id,
        attempt: delivery.attempt + 1,
        status: "dead_letter",
        errorMessage: "webhook subscription removed",
        now: this.now(),
      });
      metrics.webhookDeliveryFinal.inc({ outcome: "dead_letter" });
      return { delivery: updated ?? delivery, outcome: "dead_letter" };
    }

    if (!webhook.enabled) {
      // Subscription has been disabled; abandon without dead_letter so a
      // re-enable + admin replay can pick it back up.
      this.logger.info({ deliveryId: delivery.id, webhookId: webhook.id }, "Webhook disabled — abandoning delivery");
      return { delivery, outcome: "skipped" };
    }

    const attempt = delivery.attempt + 1;
    const ts = Math.floor(this.now() / 1000);
    const signature = this.webhookService.signRequest(webhook.secret, delivery.payload, ts);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      [SIGNATURE_HEADER]: signature,
      [DELIVERY_ID_HEADER]: delivery.deliveryId,
      "User-Agent": "skill-mcp/webhooks",
    };

    const startMs = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number | null = null;
    let body = "";
    let errorMessage: string | null = null;
    try {
      const res = await this.fetchImpl(webhook.url, {
        method: "POST",
        headers,
        body: delivery.payload,
        signal: controller.signal,
      });
      status = res.status;
      body = (await res.text()).slice(0, 2048);
    } catch (err) {
      errorMessage = (err as Error).message ?? String(err);
    } finally {
      clearTimeout(timer);
    }

    const durationMs = this.now() - startMs;
    metrics.webhookDispatchDuration.observe({ event: delivery.eventType }, durationMs / 1000);

    // Outcome decisions
    if (status !== null && status >= 200 && status < 400) {
      const updated = this.deliveryRepo.recordAttempt({
        id: delivery.id, attempt, status: "success",
        responseStatus: status, responseBody: body, now: this.now(),
      });
      metrics.webhookDeliveryFinal.inc({ outcome: "success" });
      return { delivery: updated ?? delivery, outcome: "success" };
    }

    const retryable = errorMessage !== null || (status !== null && isRetryableStatus(status));
    if (!retryable) {
      const updated = this.deliveryRepo.recordAttempt({
        id: delivery.id, attempt, status: "dead_letter",
        responseStatus: status, responseBody: body,
        errorMessage: errorMessage ?? `permanent ${status}`,
        now: this.now(),
      });
      metrics.webhookDeliveryFinal.inc({ outcome: "dead_letter" });
      return { delivery: updated ?? delivery, outcome: "dead_letter" };
    }

    // Retryable — check if we've exhausted attempts or 24h budget.
    const firstAt = delivery.firstAttemptedAt ?? this.now();
    const exhaustedAttempts = attempt >= MAX_ATTEMPTS;
    const exhaustedTime = this.now() - firstAt >= TOTAL_TIME_BUDGET_MS;
    if (exhaustedAttempts || exhaustedTime) {
      const updated = this.deliveryRepo.recordAttempt({
        id: delivery.id, attempt, status: "dead_letter",
        responseStatus: status, responseBody: body,
        errorMessage: errorMessage ?? `dead_letter after ${attempt} attempts`,
        now: this.now(),
      });
      metrics.webhookDeliveryFinal.inc({ outcome: "dead_letter" });
      return { delivery: updated ?? delivery, outcome: "dead_letter" };
    }

    // Schedule next attempt.
    const backoffMs = computeBackoffMs(attempt, this.jitterRand);
    const nextAt = this.now() + backoffMs;
    const updated = this.deliveryRepo.recordAttempt({
      id: delivery.id, attempt, status: "pending",
      responseStatus: status, responseBody: body,
      errorMessage: errorMessage ?? `transient ${status}`,
      nextRetryAt: nextAt, now: this.now(),
    });
    metrics.webhookDeliveryRetry.inc({ event: delivery.eventType });
    return { delivery: updated ?? delivery, outcome: "retry_scheduled" };
  }
}
