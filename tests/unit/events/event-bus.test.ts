import { describe, it, expect, vi } from "vitest";
import { DomainEventBus, type DomainEvent } from "../../../src/events/event-bus.js";
import { metrics, registry } from "../../../src/telemetry/metrics.js";

describe("DomainEventBus", () => {
  it("invokes registered handlers for matching event type only", () => {
    const bus = new DomainEventBus();
    const created = vi.fn();
    const updated = vi.fn();
    bus.on("skill:created", created);
    bus.on("skill:updated", updated);

    bus.publish({ type: "skill:created", slug: "x" });
    expect(created).toHaveBeenCalledTimes(1);
    expect(updated).not.toHaveBeenCalled();
  });

  it("passes the full event payload (including visibility/tags) to handlers", () => {
    const bus = new DomainEventBus();
    const handler = vi.fn();
    bus.on("skill:imported", handler);

    const event: Extract<DomainEvent, { type: "skill:imported" }> = {
      type: "skill:imported", slug: "x", visibility: "private", tags: ["t1"],
    };
    bus.publish(event);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("isolates listener failures: a throwing subscriber does not break siblings (T-303)", () => {
    const bus = new DomainEventBus();
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    bus.on("skill:created", bad);
    bus.on("skill:created", good);

    metrics.eventListenerErrors.reset();
    expect(() => bus.publish({ type: "skill:created", slug: "x" })).not.toThrow();
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it("bumps eventListenerErrors counter when a sync handler throws", async () => {
    const bus = new DomainEventBus();
    bus.on("skill:created", () => { throw new Error("nope"); });
    metrics.eventListenerErrors.reset();
    bus.publish({ type: "skill:created", slug: "x" });
    const text = await registry.metrics();
    expect(text).toMatch(/skill_mcp_event_listener_errors_total\{event="skill:created"\}\s+1/);
  });

  it("isolates async listener rejection without leaking an unhandled rejection", async () => {
    const bus = new DomainEventBus();
    const good = vi.fn();
    bus.on("skill:updated", async () => { throw new Error("async-fail"); });
    bus.on("skill:updated", good);

    metrics.eventListenerErrors.reset();
    bus.publish({ type: "skill:updated", slug: "x" });
    expect(good).toHaveBeenCalled();
    // Wait a microtask so the async rejection can be handled by the bus.
    await Promise.resolve();
    await Promise.resolve();
    const text = await registry.metrics();
    expect(text).toMatch(/skill_mcp_event_listener_errors_total\{event="skill:updated"\}\s+1/);
  });

  it("publishing with no listeners is a no-op", () => {
    const bus = new DomainEventBus();
    expect(() => bus.publish({ type: "user:roles_changed", userId: "u" })).not.toThrow();
  });

  it("allows multiple subscribers to the same event", () => {
    const bus = new DomainEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    bus.on("role:updated", a);
    bus.on("role:updated", b);
    bus.on("role:updated", c);
    bus.publish({ type: "role:updated", roleId: "r", affectedUserIds: ["u1"] });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    expect(c).toHaveBeenCalled();
  });
});
