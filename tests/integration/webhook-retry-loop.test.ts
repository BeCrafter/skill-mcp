import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@/db/migrate.js";
import { getDatabase, closeDatabase } from "@/db/connection.js";
import { WebhookRepository } from "@/db/repositories/webhook.repository.js";
import { WebhookDeliveryRepository } from "@/db/repositories/webhook-delivery.repository.js";
import { WebhookService } from "@/services/webhook.service.js";
import { WebhookDispatcher, type FetchLike } from "@/services/webhook-dispatcher.ts";

// I-09 — Webhook 8-attempt retry loop integration test (review §16.4).
//
// Wires real SQLite + WebhookRepository + WebhookDeliveryRepository +
// WebhookService + WebhookDispatcher with a stubbed fetchImpl that always
// returns 500. Loops dispatch 8 times advancing a fake clock, and asserts:
//   • status transitions: pending → pending(7x) → dead_letter
//   • attempt counter increments 1..8
//   • next_retry_at advances each retry, then is null at terminal state
//   • admin replay (reschedule) flips dead_letter back to pending
//   • a final 200 OK on a fresh delivery transitions to success on 1st attempt
//   • a 4xx response immediately dead-letters without retry

describe("Integration: Webhook 8-attempt retry loop (I-09, review §16.4)", () => {
  let testDir: string;
  let dbPath: string;
  let webhookRepo: WebhookRepository;
  let deliveryRepo: WebhookDeliveryRepository;
  let webhookService: WebhookService;
  const TENANT = "tenant-i09";
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "i09-webhook-"));
    dbPath = join(testDir, "test.db");
    runMigrations(dbPath);
    const db = getDatabase(dbPath);
    webhookRepo = new WebhookRepository(db);
    deliveryRepo = new WebhookDeliveryRepository(db);
    webhookService = new WebhookService(webhookRepo, deliveryRepo, logger, { allowPlaintext: true });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeFetch(status: number, body = "boom"): { fetchImpl: FetchLike; calls: { url: string; ts: number }[] } {
    const calls: { url: string; ts: number }[] = [];
    const fetchImpl: FetchLike = async (input) => {
      calls.push({ url: input, ts: Date.now() });
      return { status, text: async () => body };
    };
    return { fetchImpl, calls };
  }

  it("transitions a flapping endpoint through pending(7) → dead_letter after 8 attempts", async () => {
    const wh = await webhookService.create({
      tenantId: TENANT,
      url: "http://localhost:9999/hook",
      eventTypes: ["skill.published"],
    });
    const ids = await webhookService.publishEvent("skill.published", TENANT, { skill: "test" });
    expect(ids).toHaveLength(1);
    const deliveryId = ids[0];

    let now = Date.now() + 10;
    const { fetchImpl, calls } = makeFetch(500);
    const dispatcher = new WebhookDispatcher(webhookRepo, deliveryRepo, webhookService, logger, {
      fetchImpl,
      jitterRand: () => 0.5, // deterministic backoff
      now: () => now,
    });

    for (let i = 1; i <= 8; i++) {
      const due = deliveryRepo.listDue(now, 32);
      expect(due.length, `attempt ${i}: should have 1 due delivery`).toBe(1);
      const result = await dispatcher.dispatch(due[0]);
      const row = deliveryRepo.findById(deliveryId)!;
      expect(row.attempt).toBe(i);

      if (i < 8) {
        expect(result.outcome).toBe("retry_scheduled");
        expect(row.status).toBe("pending");
        expect(row.nextRetryAt).not.toBeNull();
        expect(row.nextRetryAt!).toBeGreaterThan(now);
        // Advance clock past the scheduled retry to make next iteration eligible.
        now = row.nextRetryAt!;
      } else {
        expect(result.outcome).toBe("dead_letter");
        expect(row.status).toBe("dead_letter");
        expect(row.nextRetryAt).toBeNull();
        expect(row.completedAt).not.toBeNull();
      }
    }

    expect(calls).toHaveLength(8);
    expect(calls.every(c => c.url === wh.url)).toBe(true);

    // Admin replay: reschedule should flip back to pending.
    const replayed = deliveryRepo.reschedule(deliveryId, now + 1);
    expect(replayed?.status).toBe("pending");
    expect(replayed?.nextRetryAt).toBe(now + 1);
    expect(replayed?.attempt).toBe(8); // attempt counter preserved for audit
    expect(replayed?.completedAt).toBeNull();
  });

  it("dead-letters immediately on a 4xx (permanent failure, no retry)", async () => {
    await webhookService.create({
      tenantId: TENANT,
      url: "http://localhost:9999/hook",
      eventTypes: ["skill.published"],
    });
    const [deliveryId] = await webhookService.publishEvent("skill.published", TENANT, { skill: "test" });

    const now = Date.now() + 10;
    const { fetchImpl, calls } = makeFetch(404);
    const dispatcher = new WebhookDispatcher(webhookRepo, deliveryRepo, webhookService, logger, {
      fetchImpl,
      jitterRand: () => 0,
      now: () => now,
    });

    const due = deliveryRepo.listDue(now, 32);
    const result = await dispatcher.dispatch(due[0]);
    expect(result.outcome).toBe("dead_letter");
    expect(calls).toHaveLength(1);

    const row = deliveryRepo.findById(deliveryId)!;
    expect(row.status).toBe("dead_letter");
    expect(row.attempt).toBe(1);
    expect(row.responseStatus).toBe(404);
  });

  it("succeeds on first 2xx and stamps completed_at", async () => {
    await webhookService.create({
      tenantId: TENANT,
      url: "http://localhost:9999/hook",
      eventTypes: ["pipeline.completed"],
    });
    const [deliveryId] = await webhookService.publishEvent("pipeline.completed", TENANT, { runId: "r1" });

    const now = Date.now() + 10;
    const { fetchImpl } = makeFetch(200, "ok");
    const dispatcher = new WebhookDispatcher(webhookRepo, deliveryRepo, webhookService, logger, {
      fetchImpl,
      jitterRand: () => 0,
      now: () => now,
    });

    const due = deliveryRepo.listDue(now, 32);
    const result = await dispatcher.dispatch(due[0]);
    expect(result.outcome).toBe("success");

    const row = deliveryRepo.findById(deliveryId)!;
    expect(row.status).toBe("success");
    expect(row.attempt).toBe(1);
    expect(row.responseStatus).toBe(200);
    expect(row.responseBody).toBe("ok");
    expect(row.completedAt).toBe(now);
    expect(row.nextRetryAt).toBeNull();
  });

  it("dispatchDue fans out across multiple webhook subscriptions and isolates per-row failures", async () => {
    // Two subscriptions, both subscribed to the same event.
    await webhookService.create({
      tenantId: TENANT,
      url: "http://localhost:9991/ok",
      eventTypes: ["skill.published"],
    });
    await webhookService.create({
      tenantId: TENANT,
      url: "http://localhost:9992/fail",
      eventTypes: ["skill.published"],
    });
    const ids = await webhookService.publishEvent("skill.published", TENANT, { x: 1 });
    expect(ids).toHaveLength(2);

    const now = Date.now() + 10;
    // Make /ok return 200, /fail return 500.
    const fetchImpl: FetchLike = async (input) => {
      if (input.includes("/ok")) return { status: 200, text: async () => "" };
      return { status: 500, text: async () => "" };
    };
    const dispatcher = new WebhookDispatcher(webhookRepo, deliveryRepo, webhookService, logger, {
      fetchImpl,
      jitterRand: () => 0,
      now: () => now,
    });

    const results = await dispatcher.dispatchDue(32);
    expect(results).toHaveLength(2);
    const outcomes = results.map(r => r.outcome).sort();
    expect(outcomes).toEqual(["retry_scheduled", "success"]);
  });

  it("emits HMAC signature and X-Skill-MCP-Delivery-Id headers verifiable with the stored secret", async () => {
    const wh = await webhookService.create({
      tenantId: TENANT,
      url: "http://localhost:9999/hook",
      eventTypes: ["skill.published"],
    });
    await webhookService.publishEvent("skill.published", TENANT, { hello: "world" });

    const now = Date.now() + 10;
    let captured: { headers: Record<string, string>; body: string } | null = null;
    const fetchImpl: FetchLike = async (_input, init) => {
      captured = { headers: init.headers, body: init.body };
      return { status: 200, text: async () => "" };
    };
    const dispatcher = new WebhookDispatcher(webhookRepo, deliveryRepo, webhookService, logger, {
      fetchImpl,
      jitterRand: () => 0,
      now: () => now,
    });
    const due = deliveryRepo.listDue(now, 32);
    await dispatcher.dispatch(due[0]);

    expect(captured).not.toBeNull();
    const c = captured as unknown as { headers: Record<string, string>; body: string };
    const sig = c.headers["X-Skill-MCP-Signature"];
    const did = c.headers["X-Skill-MCP-Delivery-Id"];
    expect(sig).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(did).toMatch(/^dlv_[a-z0-9]{16}$/);
    // Verify signature using the public WebhookService API (re-uses stored secret).
    expect(webhookService.verifySignature(wh.secret, c.body, sig, now)).toBe(true);
  });
});
