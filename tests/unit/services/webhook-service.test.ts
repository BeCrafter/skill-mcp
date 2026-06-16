import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema.js";
import { WebhookRepository } from "@/db/repositories/webhook.repository.js";
import { WebhookDeliveryRepository } from "@/db/repositories/webhook-delivery.repository.js";
import { WebhookService, SIGNATURE_HEADER } from "@/services/webhook.service.js";
import { BadRequestError } from "@/utils/errors.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(allowPlaintext = true) {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE webhooks (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
    event_types TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, description TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, secret_rotated_at INTEGER
  )`);
  db.run(`CREATE INDEX idx_webhooks_tenant ON webhooks(tenant_id)`);
  db.run(`CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
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
  const service = new WebhookService(webhookRepo, deliveryRepo, logger, { allowPlaintext });
  return { db, webhookRepo, deliveryRepo, service, logger };
}

describe("WebhookService (P1-16)", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  // --- URL validation ----------------------------------------------------

  describe("validateUrl", () => {
    it("accepts https in strict mode", () => {
      const strict = setup(false).service;
      expect(() => strict.validateUrl("https://example.com/hook")).not.toThrow();
    });

    it("rejects http in strict mode", () => {
      const strict = setup(false).service;
      expect(() => strict.validateUrl("http://example.com/hook")).toThrow(BadRequestError);
    });

    it("rejects loopback hostnames in strict mode", () => {
      const strict = setup(false).service;
      expect(() => strict.validateUrl("https://localhost/hook")).toThrow(BadRequestError);
      expect(() => strict.validateUrl("https://127.0.0.1/hook")).toThrow(BadRequestError);
    });

    it("rejects private IPv4 ranges in strict mode", () => {
      const strict = setup(false).service;
      expect(() => strict.validateUrl("https://10.0.0.1/hook")).toThrow(BadRequestError);
      expect(() => strict.validateUrl("https://192.168.1.1/hook")).toThrow(BadRequestError);
      expect(() => strict.validateUrl("https://172.20.0.5/hook")).toThrow(BadRequestError);
      expect(() => strict.validateUrl("https://169.254.0.1/hook")).toThrow(BadRequestError);
    });

    it("accepts http and localhost when allowPlaintext is true", () => {
      expect(() => s.service.validateUrl("http://localhost:3000/hook")).not.toThrow();
    });

    it("rejects unparseable URLs", () => {
      expect(() => s.service.validateUrl("not a url")).toThrow(BadRequestError);
    });

    it("rejects unsupported schemes even in dev", () => {
      expect(() => s.service.validateUrl("ftp://example.com/hook")).toThrow(BadRequestError);
    });
  });

  // --- Event type validation ---------------------------------------------

  describe("validateEventTypes", () => {
    it("accepts a known event type", () => {
      expect(s.service.validateEventTypes(["skill.published"])).toEqual(["skill.published"]);
    });

    it("dedupes duplicates", () => {
      expect(s.service.validateEventTypes(["skill.published", "skill.published"])).toEqual(["skill.published"]);
    });

    it("rejects empty arrays", () => {
      expect(() => s.service.validateEventTypes([])).toThrow(BadRequestError);
    });

    it("rejects unknown event types", () => {
      expect(() => s.service.validateEventTypes(["skill.invalid"])).toThrow(BadRequestError);
    });

    it("rejects non-array input", () => {
      expect(() => s.service.validateEventTypes("skill.published")).toThrow(BadRequestError);
    });
  });

  // --- CRUD --------------------------------------------------------------

  describe("create", () => {
    it("persists a row and returns the secret", async () => {
      const w = await s.service.create({
        tenantId: "default",
        url: "https://example.com/hook",
        eventTypes: ["skill.published"],
      });
      expect(w.secret).toMatch(/^[0-9a-f]{64}$/);
    });

    it("rejects an invalid URL with BadRequestError", async () => {
      await expect(async () => await s.service.create({
        tenantId: "default", url: "not a url", eventTypes: ["skill.published"],
      })).rejects.toThrow(BadRequestError);
    });
  });

  describe("update", () => {
    it("validates new URL on update", async () => {
      const w = await s.service.create({ tenantId: "default", url: "https://e.x/h", eventTypes: ["skill.published"] });
      expect(() => s.service.update(w.id, { url: "ftp://bad" })).toThrow(BadRequestError);
    });

    it("throws WebhookNotFoundError for unknown id", () => {
      expect(() => s.service.update("nope", { enabled: false })).toThrow(/Webhook not found/);
    });
  });

  describe("rotateSecret / delete", () => {
    it("rotateSecret returns a new secret", async () => {
      const w = await s.service.create({ tenantId: "default", url: "https://e.x/h", eventTypes: ["skill.published"] });
      const r = s.service.rotateSecret(w.id);
      expect(r.secret).not.toBe(w.secret);
    });

    it("delete throws when row not found", () => {
      expect(() => s.service.delete("nope")).toThrow(/Webhook not found/);
    });
  });

  // --- HMAC --------------------------------------------------------------

  describe("signRequest / verifySignature", () => {
    it("signRequest produces a t=<ts>,v1=<hex> header value", () => {
      const sig = s.service.signRequest("secret", '{"a":1}', 1700000000);
      expect(sig).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
    });

    it("verifySignature succeeds for the same body / secret / ts inside window", () => {
      const ts = Math.floor(Date.now() / 1000);
      const sig = s.service.signRequest("secret", "body", ts);
      expect(s.service.verifySignature("secret", "body", sig)).toBe(true);
    });

    it("verifySignature rejects a stale timestamp", () => {
      // Forge a header 10 minutes in the past
      const ts = Math.floor(Date.now() / 1000) - 600;
      const sig = s.service.signRequest("secret", "body", ts);
      expect(s.service.verifySignature("secret", "body", sig)).toBe(false);
    });

    it("verifySignature rejects a tampered body", () => {
      const ts = Math.floor(Date.now() / 1000);
      const sig = s.service.signRequest("secret", "body", ts);
      expect(s.service.verifySignature("secret", "tampered", sig)).toBe(false);
    });

    it("verifySignature rejects a wrong secret", () => {
      const ts = Math.floor(Date.now() / 1000);
      const sig = s.service.signRequest("secret-A", "body", ts);
      expect(s.service.verifySignature("secret-B", "body", sig)).toBe(false);
    });

    it("verifySignature rejects malformed headers", () => {
      expect(s.service.verifySignature("secret", "body", "not-a-sig")).toBe(false);
    });

    it("SIGNATURE_HEADER constant matches review §5.5.1", () => {
      expect(SIGNATURE_HEADER).toBe("X-Skill-MCP-Signature");
    });
  });

  // --- Event fan-out -----------------------------------------------------

  describe("publishEvent", () => {
    it("enqueues one delivery per matching subscription", async () => {
      await s.service.create({ tenantId: "default", url: "https://e.x/1", eventTypes: ["skill.published"] });
      await s.service.create({ tenantId: "default", url: "https://e.x/2", eventTypes: ["skill.published", "pipeline.completed"] });
      await s.service.create({ tenantId: "default", url: "https://e.x/3", eventTypes: ["pipeline.completed"] });

      const ids = await s.service.publishEvent("skill.published", "default", { skill: { slug: "foo" } });
      expect(ids).toHaveLength(2);
    });

    it("filters out disabled webhooks", async () => {
      const w = await s.service.create({ tenantId: "default", url: "https://e.x/1", eventTypes: ["skill.published"] });
      s.service.update(w.id, { enabled: false });
      const ids = await s.service.publishEvent("skill.published", "default", {});
      expect(ids).toHaveLength(0);
    });

    it("scopes by tenant", async () => {
      await s.service.create({ tenantId: "a", url: "https://e.x/1", eventTypes: ["skill.published"] });
      await s.service.create({ tenantId: "b", url: "https://e.x/2", eventTypes: ["skill.published"] });
      const ids = await s.service.publishEvent("skill.published", "a", {});
      expect(ids).toHaveLength(1);
    });

    it("returns empty without throwing when no subscriptions exist", async () => {
      const ids = await s.service.publishEvent("skill.published", "default", {});
      expect(ids).toEqual([]);
    });

    it("payload contains canonical envelope fields", async () => {
      const w = await s.service.create({ tenantId: "default", url: "https://e.x/1", eventTypes: ["skill.published"] });
      const [deliveryId] = await s.service.publishEvent("skill.published", "default", { skill: { slug: "foo" } });
      const row = s.deliveryRepo.findById(deliveryId);
      const parsed = JSON.parse(row!.payload);
      expect(parsed).toMatchObject({
        type: "skill.published",
        tenant_id: "default",
        data: { skill: { slug: "foo" } },
      });
      expect(parsed.id).toMatch(/^evt_/);
      expect(parsed.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(row!.webhookId).toBe(w.id);
    });

    it("swallows enqueue errors without throwing", async () => {
      const w = await s.service.create({ tenantId: "default", url: "https://e.x/1", eventTypes: ["skill.published"] });
      // Force enqueue to fail by stubbing the repo
      const broken = vi.spyOn(s.deliveryRepo, "enqueue").mockImplementation(() => { throw new Error("disk full"); });
      const ids = await s.service.publishEvent("skill.published", "default", {});
      expect(ids).toEqual([]);
      expect(s.logger.warn).toHaveBeenCalled();
      broken.mockRestore();
      expect(w).toBeDefined();
    });
  });
});
