import { describe, it, expect, vi } from "vitest";
import { DomainEventBus } from "@/events/event-bus.js";
import { metrics } from "@/telemetry/metrics.js";

// I-06 — DomainEventBus async dispatch + listener isolation (review §16.4).
//
// Pins three contract guarantees the rest of the system relies on:
//   1. async:true defers all listener work — publish() returns before any
//      listener runs (P0-B fix: cache invalidation no longer blocks the
//      admin write path).
//   2. A single throwing listener does NOT prevent sibling listeners from
//      running, in either sync or async mode.
//   3. A rejected async listener is caught (no UnhandledPromiseRejection)
//      and increments the eventListenerErrors metric.

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

async function getEventListenerErrorCount(eventType: string): Promise<number> {
  const got = await metrics.eventListenerErrors.get();
  const found = got.values.find((v) => v.labels?.event === eventType);
  return found?.value ?? 0;
}

describe("Integration: DomainEventBus async + isolation (I-06, review §16.4)", () => {
  it("async:true defers listeners — publish returns before any listener runs", async () => {
    const bus = new DomainEventBus({ async: true });
    let listenerRan = false;
    bus.on("skill:created", () => { listenerRan = true; });

    bus.publish({ type: "skill:created", slug: "x" });
    // Synchronously, after publish — listener has NOT yet been invoked.
    expect(listenerRan).toBe(false);

    await tick();
    expect(listenerRan).toBe(true);
  });

  it("async:false runs listeners synchronously inline with publish", () => {
    const bus = new DomainEventBus({ async: false });
    let listenerRan = false;
    bus.on("skill:created", () => { listenerRan = true; });

    bus.publish({ type: "skill:created", slug: "x" });
    expect(listenerRan).toBe(true);
  });

  it("a throwing listener does not break sibling listeners (sync mode)", () => {
    const bus = new DomainEventBus({ async: false });
    const order: string[] = [];

    bus.on("skill:created", () => { order.push("a"); });
    bus.on("skill:created", () => { order.push("b"); throw new Error("boom"); });
    bus.on("skill:created", () => { order.push("c"); });

    bus.publish({ type: "skill:created", slug: "x" });

    // All three listeners ran, even though "b" threw between "a" and "c".
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("a throwing listener does not break sibling listeners (async mode)", async () => {
    const bus = new DomainEventBus({ async: true });
    const order: string[] = [];

    bus.on("skill:created", () => { order.push("a"); });
    bus.on("skill:created", () => { order.push("b"); throw new Error("boom-sync-in-async"); });
    bus.on("skill:created", () => { order.push("c"); });

    bus.publish({ type: "skill:created", slug: "x" });
    expect(order).toEqual([]); // not yet — deferred

    await tick();
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("a rejected async listener is caught and metric increments — no UnhandledPromiseRejection", async () => {
    const bus = new DomainEventBus({ async: false });
    const before = await getEventListenerErrorCount("skill:created");

    let bRan = false;
    let cRan = false;
    bus.on("skill:created", async () => { throw new Error("rejection-test"); });
    bus.on("skill:created", () => { bRan = true; });
    bus.on("skill:created", async () => { cRan = true; });

    // Set up an unhandled-rejection trap; if the bus leaks, the test fails.
    const leaks: unknown[] = [];
    const onUnhandled = (reason: unknown) => leaks.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      bus.publish({ type: "skill:created", slug: "x" });
      // Sync siblings already ran.
      expect(bRan).toBe(true);
      // Yield to let the rejection settle through the bus's .then(_, onRejected) catcher.
      await tick();
      await tick();

      // Async sibling also resolved.
      expect(cRan).toBe(true);
      // No unhandled rejection escaped the bus.
      expect(leaks).toEqual([]);
      // Counter went up by exactly 1 for this event type.
      const after = await getEventListenerErrorCount("skill:created");
      expect(after - before).toBe(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("publish under async:true is non-blocking even with slow synchronous listeners", async () => {
    const bus = new DomainEventBus({ async: true });
    bus.on("skill:created", () => {
      // Burn ~5ms of CPU; if dispatch were sync, publish() would block here.
      const until = Date.now() + 5;
      while (Date.now() < until) { /* spin */ }
    });

    const t0 = process.hrtime.bigint();
    bus.publish({ type: "skill:created", slug: "x" });
    const t1 = process.hrtime.bigint();

    const elapsedMs = Number(t1 - t0) / 1_000_000;
    // Should be sub-millisecond on any reasonable machine.
    expect(elapsedMs).toBeLessThan(2);

    await tick();
    await tick();
  });

  it("listeners registered for a different event type are not invoked", async () => {
    const bus = new DomainEventBus({ async: true });
    const calls: string[] = [];
    bus.on("skill:created", () => { calls.push("created"); });
    bus.on("skill:deleted", () => { calls.push("deleted"); });

    bus.publish({ type: "skill:created", slug: "x" });
    await tick();

    expect(calls).toEqual(["created"]);
  });
});
