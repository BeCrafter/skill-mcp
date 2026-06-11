import { describe, it, expect, beforeEach } from "vitest";
import { metrics, registry } from "@/telemetry/metrics.js";
import { DomainEventBus } from "@/events/event-bus.js";
import { TagPermissionFilter } from "@/permission/tag-filter.js";
import type { SkillMeta, RequestContext } from "@/types/index.js";

async function getMetric(name: string): Promise<string> {
  const text = await registry.metrics();
  return text.split("\n").filter(l => l.startsWith(name)).join("\n");
}

describe("T-303 metrics", () => {
  beforeEach(() => {
    metrics.eventListenerErrors.reset();
    metrics.permissionDenials.reset();
    metrics.importFailures.reset();
  });

  it("eventListenerErrors increments when a sync listener throws", () => {
    const bus = new DomainEventBus();
    bus.on("skill:created", () => { throw new Error("boom"); });
    bus.publish({ type: "skill:created", slug: "x" });
    bus.publish({ type: "skill:created", slug: "y" });
    // Counter is keyed by event type — assert via prom-client value snapshot.
    const val = (metrics.eventListenerErrors as unknown as { hashMap: Record<string, { value: number; labels: Record<string, string> }> }).hashMap;
    const total = Object.values(val).reduce((acc, e) => acc + (e.labels.event === "skill:created" ? e.value : 0), 0);
    expect(total).toBe(2);
  });

  it("eventListenerErrors increments when an async listener rejects", async () => {
    const bus = new DomainEventBus();
    bus.on("user:roles_changed", async () => { throw new Error("async-boom"); });
    bus.publish({ type: "user:roles_changed", userId: "u1" });
    // Wait a tick so the .then(reject) handler has run.
    await new Promise((r) => setImmediate(r));
    const text = await getMetric("skill_mcp_event_listener_errors_total");
    expect(text).toMatch(/event="user:roles_changed".*\b1\b/);
  });

  it("permissionDenials increments per denied skill, labeled by visibility", async () => {
    const ctx: RequestContext = { tenantId: "default", userId: "u1", sessionId: "s1", tags: new Set(), isAuthenticated: false };
    const filter = new TagPermissionFilter(ctx);
    const skills: SkillMeta[] = [
      { id: "1", slug: "a", name: "a", version: "1.0.0", description: "", tags: [], visibility: "private", status: "published", category: "", attributes: {}, contentHash: "", storagePath: "", storageBackend: "local-fs", createdAt: 0, updatedAt: 0 } as never,
      { id: "2", slug: "b", name: "b", version: "1.0.0", description: "", tags: [], visibility: "internal", status: "published", category: "", attributes: {}, contentHash: "", storagePath: "", storageBackend: "local-fs", createdAt: 0, updatedAt: 0 } as never,
      { id: "3", slug: "c", name: "c", version: "1.0.0", description: "", tags: [], visibility: "public", status: "published", category: "", attributes: {}, contentHash: "", storagePath: "", storageBackend: "local-fs", createdAt: 0, updatedAt: 0 } as never,
    ];
    const allowed = await filter.filter(skills);
    expect(allowed.map(s => s.slug)).toEqual(["c"]);
    const text = await getMetric("skill_mcp_permission_denials_total");
    expect(text).toMatch(/visibility="private".*\b1\b/);
    expect(text).toMatch(/visibility="internal".*\b1\b/);
  });

  it("/metrics surface contains all T-303 series", async () => {
    const text = await registry.metrics();
    expect(text).toMatch(/skill_mcp_event_listener_duration_seconds/);
    expect(text).toMatch(/skill_mcp_event_listener_errors_total/);
    expect(text).toMatch(/skill_mcp_permission_denials_total/);
    expect(text).toMatch(/skill_mcp_import_duration_seconds/);
    expect(text).toMatch(/skill_mcp_import_failures_total/);
    expect(text).toMatch(/skill_mcp_active_sessions/);
  });
});
