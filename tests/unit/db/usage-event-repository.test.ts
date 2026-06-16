import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema.js";
import { UsageEventRepository, hourBucketOf } from "@/db/repositories/usage-event.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; repo: UsageEventRepository } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE usage_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    user_id TEXT,
    event_type TEXT NOT NULL,
    resource_id TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    metadata TEXT,
    hour_bucket TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX idx_usage_events_tenant_bucket ON usage_events(tenant_id, hour_bucket)`);
  db.run(`CREATE INDEX idx_usage_events_tenant_event ON usage_events(tenant_id, event_type, hour_bucket)`);
  return { db, repo: new UsageEventRepository(db) };
}

describe("UsageEventRepository (P1-13)", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  describe("hourBucketOf", () => {
    it("formats UTC hour as YYYY-MM-DDTHH", () => {
      const t = Date.UTC(2026, 4, 28, 13, 45, 12); // 2026-05-28T13:45:12Z
      expect(hourBucketOf(t)).toBe("2026-05-28T13");
    });

    it("zero-pads month / day / hour", () => {
      const t = Date.UTC(2026, 0, 1, 3, 0, 0);
      expect(hourBucketOf(t)).toBe("2026-01-01T03");
    });
  });

  describe("create", () => {
    it("inserts and returns the entity with computed hour_bucket", async () => {
      const t = Date.UTC(2026, 4, 28, 13);
      const entity = await ctx.repo.create({
        tenantId: "default",
        eventType: "skill.view",
        resourceId: "demo-skill",
        createdAt: t,
      });
      expect(entity.id).toMatch(/^[a-z0-9]{21}$/i);
      expect(entity.hourBucket).toBe("2026-05-28T13");
      expect(entity.quantity).toBe(1);
      expect(entity.metadata).toBeNull();
    });

    it("serialises metadata to JSON and parses it back on list", async () => {
      const t = Date.UTC(2026, 4, 28, 13);
      await ctx.repo.create({
        tenantId: "default",
        eventType: "pipeline.run",
        resourceId: "p1",
        quantity: 3,
        metadata: { status: "success", stages: ["a", "b", "c"] },
        createdAt: t,
      });
      const events = ctx.repo.list({ tenantId: "default" });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toEqual({ status: "success", stages: ["a", "b", "c"] });
      expect(events[0].quantity).toBe(3);
    });
  });

  describe("createMany", () => {
    it("returns 0 for empty input without inserting", () => {
      expect(ctx.repo.createMany([])).toBe(0);
      expect(ctx.repo.list({ tenantId: "default" })).toEqual([]);
    });

    it("bulk inserts with per-row hour buckets", () => {
      const n = ctx.repo.createMany([
        { tenantId: "default", eventType: "api.call", createdAt: Date.UTC(2026, 4, 28, 10) },
        { tenantId: "default", eventType: "api.call", createdAt: Date.UTC(2026, 4, 28, 11) },
        { tenantId: "tenant-b", eventType: "api.call", createdAt: Date.UTC(2026, 4, 28, 11) },
      ]);
      expect(n).toBe(3);
      expect(ctx.repo.list({ tenantId: "default" })).toHaveLength(2);
      expect(ctx.repo.list({ tenantId: "tenant-b" })).toHaveLength(1);
    });
  });

  describe("aggregate", () => {
    beforeEach(() => {
      ctx.repo.createMany([
        { tenantId: "default", eventType: "skill.view", quantity: 1, createdAt: Date.UTC(2026, 4, 28, 10) },
        { tenantId: "default", eventType: "skill.view", quantity: 1, createdAt: Date.UTC(2026, 4, 28, 10) },
        { tenantId: "default", eventType: "pipeline.run", quantity: 4, createdAt: Date.UTC(2026, 4, 28, 10) },
        { tenantId: "default", eventType: "skill.view", quantity: 1, createdAt: Date.UTC(2026, 4, 28, 11) },
        { tenantId: "tenant-b", eventType: "skill.view", quantity: 5, createdAt: Date.UTC(2026, 4, 28, 11) },
      ]);
    });

    it("groups by (event_type, hour_bucket) and sums quantity", () => {
      const rows = ctx.repo.aggregate({ tenantId: "default" });
      const view10 = rows.find(r => r.hourBucket === "2026-05-28T10" && r.eventType === "skill.view");
      const view11 = rows.find(r => r.hourBucket === "2026-05-28T11" && r.eventType === "skill.view");
      const run10 = rows.find(r => r.hourBucket === "2026-05-28T10" && r.eventType === "pipeline.run");
      expect(view10?.totalQuantity).toBe(2);
      expect(view10?.eventCount).toBe(2);
      expect(view11?.totalQuantity).toBe(1);
      expect(run10?.totalQuantity).toBe(4);
    });

    it("isolates tenants", () => {
      const rows = ctx.repo.aggregate({ tenantId: "tenant-b" });
      expect(rows).toHaveLength(1);
      expect(rows[0].totalQuantity).toBe(5);
    });

    it("filters by event type", () => {
      const rows = ctx.repo.aggregate({ tenantId: "default", eventType: "pipeline.run" });
      expect(rows).toHaveLength(1);
      expect(rows[0].eventType).toBe("pipeline.run");
    });

    it("filters by hour bucket range (inclusive)", () => {
      const rows = ctx.repo.aggregate({
        tenantId: "default",
        fromBucket: "2026-05-28T11",
        toBucket: "2026-05-28T11",
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].hourBucket).toBe("2026-05-28T11");
      expect(rows[0].eventType).toBe("skill.view");
    });
  });

  describe("sumQuantity", () => {
    it("returns 0 when no rows match", () => {
      expect(ctx.repo.sumQuantity({ tenantId: "default" })).toBe(0);
    });

    it("sums across all matching rows", () => {
      ctx.repo.createMany([
        { tenantId: "default", eventType: "storage.write", quantity: 100, createdAt: Date.UTC(2026, 4, 28, 10) },
        { tenantId: "default", eventType: "storage.write", quantity: 250, createdAt: Date.UTC(2026, 4, 28, 11) },
      ]);
      expect(ctx.repo.sumQuantity({ tenantId: "default", eventType: "storage.write" })).toBe(350);
    });
  });

  describe("list", () => {
    it("orders by created_at desc and respects limit", async () => {
      await ctx.repo.create({ tenantId: "default", eventType: "api.call", createdAt: 1000, resourceId: "old" });
      await ctx.repo.create({ tenantId: "default", eventType: "api.call", createdAt: 2000, resourceId: "mid" });
      await ctx.repo.create({ tenantId: "default", eventType: "api.call", createdAt: 3000, resourceId: "new" });
      const events = ctx.repo.list({ tenantId: "default", limit: 2 });
      expect(events).toHaveLength(2);
      expect(events[0].resourceId).toBe("new");
      expect(events[1].resourceId).toBe("mid");
    });

    it("clamps limit to [1, 10000]", async () => {
      await ctx.repo.create({ tenantId: "default", eventType: "api.call", createdAt: 1 });
      expect(ctx.repo.list({ tenantId: "default", limit: 0 })).toHaveLength(1);
      expect(ctx.repo.list({ tenantId: "default", limit: -5 })).toHaveLength(1);
    });

    it("returns null metadata when JSON is corrupt rather than throwing", () => {
      // Insert a row with an invalid JSON metadata column directly.
      ctx.db.run(`INSERT INTO usage_events
        (id, tenant_id, event_type, quantity, metadata, hour_bucket, created_at)
        VALUES ('id1', 'default', 'api.call', 1, '{not-json', '2026-05-28T13', 100)`);
      const events = ctx.repo.list({ tenantId: "default" });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toBeNull();
    });

    it("returns null metadata when JSON parses to a non-object", () => {
      ctx.db.run(`INSERT INTO usage_events
        (id, tenant_id, event_type, quantity, metadata, hour_bucket, created_at)
        VALUES ('id1', 'default', 'api.call', 1, '"a string"', '2026-05-28T13', 100)`);
      const events = ctx.repo.list({ tenantId: "default" });
      expect(events[0].metadata).toBeNull();
    });
  });

  describe("deleteOlderThan", () => {
    it("deletes rows with created_at < cutoff", async () => {
      await ctx.repo.create({ tenantId: "default", eventType: "api.call", createdAt: 100 });
      await ctx.repo.create({ tenantId: "default", eventType: "api.call", createdAt: 500 });
      await ctx.repo.create({ tenantId: "default", eventType: "api.call", createdAt: 1000 });
      const deleted = ctx.repo.deleteOlderThan(600);
      expect(deleted).toBe(2);
      const remaining = ctx.repo.list({ tenantId: "default" });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].createdAt).toBe(1000);
    });
  });
});
