import { describe, it, expect, vi } from "vitest";
import { WebhookWorker } from "@/services/webhook-worker.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

describe("WebhookWorker (P1-16)", () => {
  it("tick() returns the number of dispatched rows", async () => {
    const dispatcher = { dispatchDue: vi.fn().mockResolvedValue([{ outcome: "success" }, { outcome: "success" }]) } as never;
    const w = new WebhookWorker(dispatcher, makeLogger());
    expect(await w.tick()).toBe(2);
    expect(dispatcher.dispatchDue).toHaveBeenCalledWith(32);
  });

  it("respects custom batchSize", async () => {
    const dispatcher = { dispatchDue: vi.fn().mockResolvedValue([]) } as never;
    const w = new WebhookWorker(dispatcher, makeLogger(), { batchSize: 8 });
    await w.tick();
    expect(dispatcher.dispatchDue).toHaveBeenCalledWith(8);
  });

  it("start/stop lifecycle is idempotent", async () => {
    const dispatcher = { dispatchDue: vi.fn().mockResolvedValue([]) } as never;
    const w = new WebhookWorker(dispatcher, makeLogger(), { idlePollIntervalMs: 60_000 });
    w.start();
    w.start(); // second call no-op
    await new Promise(r => setTimeout(r, 30));
    await w.stop();
    await w.stop(); // second call no-op
    expect(dispatcher.dispatchDue).toHaveBeenCalled();
  });

  it("propagates dispatcher errors as logged tick errors (no crash)", async () => {
    const dispatcher = { dispatchDue: vi.fn().mockRejectedValue(new Error("boom")) } as never;
    const logger = makeLogger();
    const w = new WebhookWorker(dispatcher, logger);
    await expect(w.tick()).rejects.toThrow("boom");
    // start/stop cycle keeps the worker alive even when ticks fail
    w.start();
    await new Promise(r => setTimeout(r, 30));
    await w.stop();
    expect((logger as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalled();
  });
});
