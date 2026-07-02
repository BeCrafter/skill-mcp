import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema.js";
import { WebhookRepository } from "@/db/repositories/webhook.repository.js";
import { WebhookDeliveryRepository } from "@/db/repositories/webhook-delivery.repository.js";
import { WebhookService, SIGNATURE_HEADER, DELIVERY_ID_HEADER } from "@/services/webhook.service.js";
import { WebhookDispatcher, computeBackoffMs, isRetryableStatus, type FetchLike } from "@/services/webhook-dispatcher.ts";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE webhooks (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL,
    event_types TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, description TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, secret_rotated_at INTEGER
  )`);
  db.run(`CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL,
    event_type TEXT NOT NULL, delivery_id TEXT NOT NULL, payload TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
    response_status INTEGER, response_body TEXT, error_message TEXT,
    next_retry_at INTEGER, first_attempted_at INTEGER, last_attempted_at INTEGER,
    completed_at INTEGER, created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE UNIQUE INDEX idx_webhook_deliveries_delivery_id ON webhook_deliveries(delivery_id)`);
  const webhookRepo = new WebhookRepository(db);
  const deliveryRepo = new WebhookDeliveryRepository(db);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  const service = new WebhookService(webhookRepo, deliveryRepo, logger, { allowPlaintext: true });
  return { db, webhookRepo, deliveryRepo, service, logger };
}

function makeFetchOk(captureHeaders?: Record<string, string>): FetchLike {
  return vi.fn(async (_url, init) => {
    if (captureHeaders) Object.assign(captureHeaders, init.headers);
    return { status: 200, text: async () => '{"ok":true}' };
  });
}

describe("computeBackoffMs", () => {
  it("attempt 1 with jitter=0 → 2 seconds", () => {
    expect(computeBackoffMs(1, () => 0)).toBe(2000);
  });

  it("attempt 4 with jitter=0 → 16 seconds", () => {
    expect(computeBackoffMs(4, () => 0)).toBe(16_000);
  });

  it("caps at 600 seconds for high attempts", () => {
    expect(computeBackoffMs(20, () => 0)).toBe(600_000);
  });

  it("adds jitter (max 1 sec)", () => {
    const v = computeBackoffMs(2, () => 0.5);
    expect(v).toBe(4500); // 2^2 + 0.5 = 4.5 sec
  });
});

describe("isRetryableStatus", () => {
  it("2xx is not retryable", () => { expect(isRetryableStatus(200)).toBe(false); });
  it("3xx is not retryable", () => { expect(isRetryableStatus(304)).toBe(false); });
  it("4xx (other) is permanent", () => { expect(isRetryableStatus(400)).toBe(false); });
  it("404 is permanent", () => { expect(isRetryableStatus(404)).toBe(false); });
  it("408 retryable", () => { expect(isRetryableStatus(408)).toBe(true); });
  it("429 retryable", () => { expect(isRetryableStatus(429)).toBe(true); });
  it("5xx retryable", () => { expect(isRetryableStatus(503)).toBe(true); });
});

describe("WebhookDispatcher (P1-16)", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it("dispatch success: 2xx → status=success, response captured", async () => {
    const w = await s.service.create({ url: "https://e.x/h", eventTypes: ["skill.published"] });
    const d = await s.deliveryRepo.enqueue({ webhookId: w.id, eventType: "skill.published", payload: '{"x":1}' });
    const fetchImpl = makeFetchOk();
    const dispatcher = new WebhookDispatcher(s.webhookRepo, s.deliveryRepo, s.service, s.logger, { fetchImpl });
    const r = await dispatcher.dispatch(d);
    expect(r.outcome).toBe("success");
    expect(r.delivery.status).toBe("success");
    expect(r.delivery.responseStatus).toBe(200);
    expect(r.delivery.attempt).toBe(1);
    expect(r.delivery.completedAt).toBeTypeOf("number");
  });

  it("dispatch sends signature + delivery-id headers", async () => {
    const w = await s.service.create({ url: "https://e.x/h", eventTypes: ["skill.published"] });
    const d = await s.deliveryRepo.enqueue({
      webhookId: w.id, eventType: "skill.published", payload: '{"x":1}',
      deliveryId: "fixed-uuid",
    });
    const captured: Record<string, string> = {};
    const dispatcher = new WebhookDispatcher(s.webhookRepo, s.deliveryRepo, s.service, s.logger, {
      fetchImpl: makeFetchOk(captured),
      now: () => 1700000000000,
    });
    await dispatcher.dispatch(d);
    expect(captured[SIGNATURE_HEADER]).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
    expect(captured[DELIVERY_ID_HEADER]).toBe("fixed-uuid");
    expect(captured["Content-Type"]).toBe("application/json");
  });

  it("4xx (non-408/429) → dead_letter, no retry", async () => {
    const w = await s.service.create({ url: "https://e.x/h", eventTypes: ["skill.published"] });
    const d = await s.deliveryRepo.enqueue({ webhookId: w.id, eventType: "skill.published", payload: "{}" });
    const fetchImpl = vi.fn(async () => ({ status: 404, text: async () => "not found" })) as never;
    const dispatcher = new WebhookDispatcher(s.webhookRepo, s.deliveryRepo, s.service, s.logger, { fetchImpl });
    const r = await dispatcher.dispatch(d);
    expect(r.outcome).toBe("dead_letter");
    expect(r.delivery.status).toBe("dead_letter");
    expect(r.delivery.responseStatus).toBe(404);
  });

  it("5xx → schedules retry with backoff", async () => {
    const w = await s.service.create({ url: "https://e.x/h", eventTypes: ["skill.published"] });
    const d = await s.deliveryRepo.enqueue({ webhookId: w.id, eventType: "skill.published", payload: "{}" });
    const fetchImpl = vi.fn(async () => ({ status: 503, text: async () => "" })) as never;
    let nowMs = 1_000_000;
    const dispatcher = new WebhookDispatcher(s.webhookRepo, s.deliveryRepo, s.service, s.logger, {
      fetchImpl,
      jitterRand: () => 0,
      now: () => nowMs,
    });
    const r = await dispatcher.dispatch(d);
    expect(r.outcome).toBe("retry_scheduled");
    expect(r.delivery.status).toBe("pending");
    expect(r.delivery.attempt).toBe(1);
    // attempt 1 jitter=0 → 2s backoff → next_retry_at = now + 2000
    expect(r.delivery.nextRetryAt).toBe(1_002_000);
  });

  it("network error (fetch throws) → schedule retry", async () => {
    const w = await s.service.create({ url: "https://e.x/h", eventTypes: ["skill.published"] });
    const d = await s.deliveryRepo.enqueue({ webhookId: w.id, eventType: "skill.published", payload: "{}" });
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as never;
    const dispatcher = new WebhookDispatcher(s.webhookRepo, s.deliveryRepo, s.service, s.logger, {
      fetchImpl, jitterRand: () => 0,
    });
    const r = await dispatcher.dispatch(d);
    expect(r.outcome).toBe("retry_scheduled");
    expect(r.delivery.errorMessage).toContain("ECONNREFUSED");
  });

  it("8th failed attempt → dead_letter (max attempts)", async () => {
    const w = await s.service.create({ url: "https://e.x/h", eventTypes: ["skill.published"] });
    const d = await s.deliveryRepo.enqueue({ webhookId: w.id, eventType: "skill.published", payload: "{}" });
    // Pre-set the row to attempt=7 — the next dispatch is the 8th.
    s.db.run(`UPDATE webhook_deliveries SET attempt = 7, first_attempted_at = 1, last_attempted_at = 1`);
    const fresh = s.deliveryRepo.findById(d.id)!;
    const fetchImpl = vi.fn(async () => ({ status: 503, text: async () => "" })) as never;
    const dispatcher = new WebhookDispatcher(s.webhookRepo, s.deliveryRepo, s.service, s.logger, { fetchImpl });
    const r = await dispatcher.dispatch(fresh);
    expect(r.outcome).toBe("dead_letter");
    expect(r.delivery.attempt).toBe(8);
  });

  it("24h budget exhausted → dead_letter even before 8 attempts", async () => {
    const w = await s.service.create({ url: "https://e.x/h", eventTypes: ["skill.published"] });
    const d = await s.deliveryRepo.enqueue({ webhookId: w.id, eventType: "skill.published", payload: "{}" });
    // first_attempted_at = 1 ms epoch; "now" is 25 hours later
    s.db.run(`UPDATE webhook_deliveries SET attempt = 3, first_attempted_at = 1`);
    const fresh = s.deliveryRepo.findById(d.id)!;
    const fetchImpl = vi.fn(async () => ({ status: 503, text: async () => "" })) as never;
    const dispatcher = new WebhookDispatcher(s.webhookRepo, s.deliveryRepo, s.service, s.logger, {
      fetchImpl,
      now: () => 25 * 60 * 60 * 1000,
    });
    const r = await dispatcher.dispatch(fresh);
    expect(r.outcome).toBe("dead_letter");
    expect(r.delivery.attempt).toBe(4);
  });

  it("missing webhook → dead_letter (subscription deleted)", async () => {
    const w = await s.service.create({ url: "https://e.x/h", eventTypes: ["skill.published"] });
    const d = await s.deliveryRepo.enqueue({ webhookId: w.id, eventType: "skill.published", payload: "{}" });
    s.webhookRepo.delete(w.id);
    const dispatcher = new WebhookDispatcher(s.webhookRepo, s.deliveryRepo, s.service, s.logger, { fetchImpl: makeFetchOk() });
    const r = await dispatcher.dispatch(d);
    expect(r.outcome).toBe("dead_letter");
    expect(r.delivery.errorMessage).toContain("removed");
  });

  it("disabled webhook → skipped without recording attempt", async () => {
    const w = await s.service.create({ url: "https://e.x/h", eventTypes: ["skill.published"] });
    s.service.update(w.id, { enabled: false });
    const d = await s.deliveryRepo.enqueue({ webhookId: w.id, eventType: "skill.published", payload: "{}" });
    const dispatcher = new WebhookDispatcher(s.webhookRepo, s.deliveryRepo, s.service, s.logger, { fetchImpl: makeFetchOk() });
    const r = await dispatcher.dispatch(d);
    expect(r.outcome).toBe("skipped");
    // attempt counter should not have moved.
    const reloaded = s.deliveryRepo.findById(d.id)!;
    expect(reloaded.attempt).toBe(0);
  });

  it("dispatchDue iterates over all due rows", async () => {
    const w = await s.service.create({ url: "https://e.x/h", eventTypes: ["skill.published"] });
    await s.deliveryRepo.enqueue({ webhookId: w.id, eventType: "skill.published", payload: "{}", now: 100 });
    await s.deliveryRepo.enqueue({ webhookId: w.id, eventType: "skill.published", payload: "{}", now: 200 });
    const fetchImpl = makeFetchOk();
    const dispatcher = new WebhookDispatcher(s.webhookRepo, s.deliveryRepo, s.service, s.logger, {
      fetchImpl, now: () => 500,
    });
    const results = await dispatcher.dispatchDue(10);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.outcome === "success")).toBe(true);
  });

  it("dispatchDue isolates row failures (one row throws → batch continues)", async () => {
    const w = await s.service.create({ url: "https://e.x/h", eventTypes: ["skill.published"] });
    await s.deliveryRepo.enqueue({ webhookId: w.id, eventType: "skill.published", payload: "{}", now: 100 });
    await s.deliveryRepo.enqueue({ webhookId: w.id, eventType: "skill.published", payload: "{}", now: 200 });

    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { status: 200, text: async () => "" };
    }) as never;
    const dispatcher = new WebhookDispatcher(s.webhookRepo, s.deliveryRepo, s.service, s.logger, {
      fetchImpl, now: () => 500, jitterRand: () => 0,
    });
    const results = await dispatcher.dispatchDue(10);
    expect(results).toHaveLength(2);
    // First row got a network error → retry; second succeeded.
    expect(results[0].outcome).toBe("retry_scheduled");
    expect(results[1].outcome).toBe("success");
  });
});
