import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema.js";
import { WebhookRepository } from "@/db/repositories/webhook.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; repo: WebhookRepository } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    event_types TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    secret_rotated_at INTEGER
  )`);
  db.run(`CREATE INDEX idx_webhooks_tenant ON webhooks(tenant_id)`);
  return { db, repo: new WebhookRepository(db) };
}

describe("WebhookRepository (P1-16)", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it("create generates a 64-char hex secret when none supplied", async () => {
    const w = await s.repo.create({
      tenantId: "default",
      url: "https://example.com/hook",
      eventTypes: ["skill.published"],
    });
    expect(w.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(w.enabled).toBe(true);
    expect(w.eventTypes).toEqual(["skill.published"]);
  });

  it("create accepts an explicit secret (test fixtures)", async () => {
    const w = await s.repo.create({
      tenantId: "default",
      url: "https://example.com/hook",
      eventTypes: ["pipeline.completed"],
      secret: "deadbeef",
    });
    expect(w.secret).toBe("deadbeef");
  });

  it("findById round-trips event_types JSON", async () => {
    const created = await s.repo.create({
      tenantId: "default",
      url: "https://example.com/hook",
      eventTypes: ["skill.published", "skill.deprecated"],
    });
    const found = s.repo.findById(created.id);
    expect(found?.eventTypes).toEqual(["skill.published", "skill.deprecated"]);
  });

  it("findById returns null for unknown id", () => {
    expect(s.repo.findById("nope")).toBeNull();
  });

  it("listByTenant scopes by tenant_id", async () => {
    await s.repo.create({ tenantId: "a", url: "https://example.com/1", eventTypes: ["skill.published"] });
    await s.repo.create({ tenantId: "a", url: "https://example.com/2", eventTypes: ["skill.published"] });
    await s.repo.create({ tenantId: "b", url: "https://example.com/3", eventTypes: ["skill.published"] });
    expect(s.repo.listByTenant("a")).toHaveLength(2);
    expect(s.repo.listByTenant("b")).toHaveLength(1);
    expect(s.repo.listByTenant("c")).toHaveLength(0);
  });

  it("listEnabledForEvent filters by enabled flag and subscribed event", async () => {
    const w1 = await s.repo.create({ tenantId: "default", url: "https://example.com/1", eventTypes: ["skill.published"] });
    await s.repo.create({ tenantId: "default", url: "https://example.com/2", eventTypes: ["pipeline.completed"] });
    const w3 = await s.repo.create({ tenantId: "default", url: "https://example.com/3", eventTypes: ["skill.published", "skill.deprecated"] });
    s.repo.update(w3.id, { enabled: false });

    const matched = s.repo.listEnabledForEvent("default", "skill.published");
    expect(matched.map(e => e.id).sort()).toEqual([w1.id].sort());
  });

  it("update is partial — unspecified fields stay", async () => {
    const w = await s.repo.create({ tenantId: "default", url: "https://example.com", eventTypes: ["skill.published"], description: "orig" });
    // Wait 2ms so updated_at differs
    await new Promise(r => setTimeout(r, 2));
    const updated = s.repo.update(w.id, { url: "https://new.example.com" });
    expect(updated?.url).toBe("https://new.example.com");
    expect(updated?.description).toBe("orig");
    expect(updated!.updatedAt).toBeGreaterThan(w.updatedAt);
  });

  it("update can disable a webhook", async () => {
    const w = await s.repo.create({ tenantId: "default", url: "https://example.com", eventTypes: ["skill.published"] });
    const updated = s.repo.update(w.id, { enabled: false });
    expect(updated?.enabled).toBe(false);
  });

  it("update returns null for unknown id", () => {
    expect(s.repo.update("nope", { enabled: false })).toBeNull();
  });

  it("rotateSecret produces a fresh 64-char hex secret and stamps secretRotatedAt", async () => {
    const w = await s.repo.create({ tenantId: "default", url: "https://example.com", eventTypes: ["skill.published"] });
    const rotated = s.repo.rotateSecret(w.id);
    expect(rotated?.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated?.secret).not.toBe(w.secret);
    expect(rotated?.secretRotatedAt).toBeTypeOf("number");
  });

  it("rotateSecret returns null for unknown id", () => {
    expect(s.repo.rotateSecret("nope")).toBeNull();
  });

  it("delete removes the row and returns true", async () => {
    const w = await s.repo.create({ tenantId: "default", url: "https://example.com", eventTypes: ["skill.published"] });
    expect(s.repo.delete(w.id)).toBe(true);
    expect(s.repo.findById(w.id)).toBeNull();
  });

  it("delete returns false for unknown id", () => {
    expect(s.repo.delete("nope")).toBe(false);
  });

  it("toEntity tolerates corrupt event_types JSON", () => {
    s.db.run(`INSERT INTO webhooks (id, tenant_id, url, secret, event_types, enabled, created_at, updated_at)
              VALUES ('corrupt', 'default', 'https://e.x', 's', 'not-json{', 1, 0, 0)`);
    const found = s.repo.findById("corrupt");
    expect(found?.eventTypes).toEqual([]);
  });
});
