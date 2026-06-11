import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema.js";
import { WebhookDeliveryRepository } from "@/db/repositories/webhook-delivery.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; repo: WebhookDeliveryRepository } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    response_status INTEGER,
    response_body TEXT,
    error_message TEXT,
    next_retry_at INTEGER,
    first_attempted_at INTEGER,
    last_attempted_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE UNIQUE INDEX idx_webhook_deliveries_delivery_id ON webhook_deliveries(delivery_id)`);
  db.run(`CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(status, next_retry_at)`);
  return { db, repo: new WebhookDeliveryRepository(db) };
}

describe("WebhookDeliveryRepository (P1-16)", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it("enqueue creates a pending row with next_retry_at = now", () => {
    const d = s.repo.enqueue({
      webhookId: "w1", tenantId: "default", eventType: "skill.published",
      payload: '{"x":1}', now: 100,
    });
    expect(d.status).toBe("pending");
    expect(d.attempt).toBe(0);
    expect(d.nextRetryAt).toBe(100);
    expect(d.deliveryId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("enqueue accepts an explicit deliveryId (test fixtures)", () => {
    const d = s.repo.enqueue({
      webhookId: "w1", tenantId: "default", eventType: "skill.published",
      payload: "{}", deliveryId: "fixed-uuid",
    });
    expect(d.deliveryId).toBe("fixed-uuid");
  });

  it("listDue picks rows where status=pending AND next_retry_at <= now", () => {
    const a = s.repo.enqueue({ webhookId: "w1", tenantId: "t", eventType: "e", payload: "{}", now: 10 });
    const b = s.repo.enqueue({ webhookId: "w1", tenantId: "t", eventType: "e", payload: "{}", now: 50 });
    const c = s.repo.enqueue({ webhookId: "w1", tenantId: "t", eventType: "e", payload: "{}", now: 100 });
    // mark c success — must not appear
    s.repo.recordAttempt({ id: c.id, attempt: 1, status: "success", now: 100 });

    const due = s.repo.listDue(60);
    expect(due.map(d => d.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("listDue orders by next_retry_at asc and respects limit", () => {
    const a = s.repo.enqueue({ webhookId: "w1", tenantId: "t", eventType: "e", payload: "{}", now: 100 });
    const b = s.repo.enqueue({ webhookId: "w1", tenantId: "t", eventType: "e", payload: "{}", now: 10 });
    s.repo.enqueue({ webhookId: "w1", tenantId: "t", eventType: "e", payload: "{}", now: 200 });

    const due = s.repo.listDue(150, 2);
    expect(due).toHaveLength(2);
    expect(due[0].id).toBe(b.id);
    expect(due[1].id).toBe(a.id);
  });

  it("recordAttempt success clears nextRetryAt and stamps completedAt", () => {
    const d = s.repo.enqueue({ webhookId: "w1", tenantId: "t", eventType: "e", payload: "{}", now: 100 });
    const updated = s.repo.recordAttempt({
      id: d.id, attempt: 1, status: "success", responseStatus: 200, now: 150,
    });
    expect(updated?.status).toBe("success");
    expect(updated?.responseStatus).toBe(200);
    expect(updated?.nextRetryAt).toBeNull();
    expect(updated?.completedAt).toBe(150);
    expect(updated?.firstAttemptedAt).toBe(150);
    expect(updated?.lastAttemptedAt).toBe(150);
  });

  it("recordAttempt pending updates next_retry_at without clearing", () => {
    const d = s.repo.enqueue({ webhookId: "w1", tenantId: "t", eventType: "e", payload: "{}", now: 100 });
    const updated = s.repo.recordAttempt({
      id: d.id, attempt: 1, status: "pending", responseStatus: 503,
      errorMessage: "upstream 503", nextRetryAt: 200, now: 150,
    });
    expect(updated?.status).toBe("pending");
    expect(updated?.nextRetryAt).toBe(200);
    expect(updated?.errorMessage).toBe("upstream 503");
    expect(updated?.completedAt).toBeNull();
  });

  it("recordAttempt dead_letter clears retry timer and stamps completedAt", () => {
    const d = s.repo.enqueue({ webhookId: "w1", tenantId: "t", eventType: "e", payload: "{}", now: 100 });
    const updated = s.repo.recordAttempt({
      id: d.id, attempt: 8, status: "dead_letter", errorMessage: "exhausted", now: 999,
    });
    expect(updated?.status).toBe("dead_letter");
    expect(updated?.nextRetryAt).toBeNull();
    expect(updated?.completedAt).toBe(999);
  });

  it("recordAttempt preserves firstAttemptedAt across multiple attempts", () => {
    const d = s.repo.enqueue({ webhookId: "w1", tenantId: "t", eventType: "e", payload: "{}", now: 100 });
    s.repo.recordAttempt({ id: d.id, attempt: 1, status: "pending", nextRetryAt: 200, now: 110 });
    const second = s.repo.recordAttempt({ id: d.id, attempt: 2, status: "pending", nextRetryAt: 400, now: 220 });
    expect(second?.firstAttemptedAt).toBe(110);
    expect(second?.lastAttemptedAt).toBe(220);
  });

  it("recordAttempt returns null for unknown id", () => {
    expect(s.repo.recordAttempt({ id: "nope", attempt: 1, status: "success" })).toBeNull();
  });

  it("reschedule flips dead_letter back to pending", () => {
    const d = s.repo.enqueue({ webhookId: "w1", tenantId: "t", eventType: "e", payload: "{}", now: 100 });
    s.repo.recordAttempt({ id: d.id, attempt: 8, status: "dead_letter", now: 999 });
    const replayed = s.repo.reschedule(d.id, 5000);
    expect(replayed?.status).toBe("pending");
    expect(replayed?.nextRetryAt).toBe(5000);
    expect(replayed?.completedAt).toBeNull();
    expect(replayed?.attempt).toBe(8);
  });

  it("reschedule returns null for unknown id", () => {
    expect(s.repo.reschedule("nope")).toBeNull();
  });

  it("listByWebhook orders newest first and respects limit", () => {
    const w = "w1";
    const a = s.repo.enqueue({ webhookId: w, tenantId: "t", eventType: "e", payload: "{}", now: 100 });
    const b = s.repo.enqueue({ webhookId: w, tenantId: "t", eventType: "e", payload: "{}", now: 200 });
    s.repo.enqueue({ webhookId: w, tenantId: "t", eventType: "e", payload: "{}", now: 300 });
    const out = s.repo.listByWebhook(w, 2);
    expect(out).toHaveLength(2);
    // Two of these have created_at = 300/200 (the third) and 200/100 (b/a)
    // The repo orders desc by createdAt, so newest = 300, then 200.
    // We sliced to 2, so we should not see `a` (created_at = 100).
    expect(out.find(x => x.id === a.id)).toBeUndefined();
    expect(out.find(x => x.id === b.id)).toBeDefined();
  });

  it("listByTenant scopes by tenant_id", () => {
    s.repo.enqueue({ webhookId: "w1", tenantId: "a", eventType: "e", payload: "{}", now: 1 });
    s.repo.enqueue({ webhookId: "w2", tenantId: "b", eventType: "e", payload: "{}", now: 2 });
    expect(s.repo.listByTenant("a")).toHaveLength(1);
    expect(s.repo.listByTenant("b")).toHaveLength(1);
    expect(s.repo.listByTenant("c")).toHaveLength(0);
  });

  it("delete removes a row and returns true", () => {
    const d = s.repo.enqueue({ webhookId: "w1", tenantId: "t", eventType: "e", payload: "{}", now: 100 });
    expect(s.repo.delete(d.id)).toBe(true);
    expect(s.repo.findById(d.id)).toBeNull();
  });

  it("delete returns false for unknown id", () => {
    expect(s.repo.delete("nope")).toBe(false);
  });

  it("unique deliveryId index rejects duplicates", () => {
    s.repo.enqueue({
      webhookId: "w1", tenantId: "t", eventType: "e", payload: "{}",
      deliveryId: "dup-id", now: 100,
    });
    expect(() =>
      s.repo.enqueue({
        webhookId: "w2", tenantId: "t", eventType: "e", payload: "{}",
        deliveryId: "dup-id", now: 100,
      }),
    ).toThrow();
  });
});
