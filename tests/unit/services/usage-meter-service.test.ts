import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";
import { UsageMeterService } from "../../../src/services/usage-meter.service.js";
import type {
  UsageEventRepository,
  AggregateRow,
  UsageEventEntity,
} from "../../../src/db/repositories/usage-event.repository.js";

function fakeLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

describe("UsageMeterService (P1-13)", () => {
  it("record() delegates to repo.create with input passed through", async () => {
    const create = vi.fn();
    const repo = { create } as unknown as UsageEventRepository;
    const svc = new UsageMeterService(repo, fakeLogger());

    await svc.record({
      eventType: "skill.view",
      resourceId: "demo",
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "skill.view",
      resourceId: "demo",
    }));
  });

  it("record() never rejects when the repository throws", async () => {
    const create = vi.fn().mockImplementation(() => { throw new Error("boom"); });
    const repo = { create } as unknown as UsageEventRepository;
    const logger = fakeLogger();
    const svc = new UsageMeterService(repo, logger);

    // Critically: a metering failure on the hot path must not propagate.
    await expect(svc.record({ eventType: "api.call" })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), eventType: "api.call" }),
      expect.stringMatching(/fire-and-forget/),
    );
  });

  it("recordSync() runs synchronously (no setImmediate hop)", () => {
    const create = vi.fn();
    const repo = { create } as unknown as UsageEventRepository;
    const svc = new UsageMeterService(repo, fakeLogger());

    svc.recordSync({ eventType: "skill.view" });

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("aggregate() passes opts through to repo.aggregate", () => {
    const rows: AggregateRow[] = [
      { eventType: "skill.view", hourBucket: "2026-05-28T10", totalQuantity: 5, eventCount: 5 },
    ];
    const aggregate = vi.fn().mockReturnValue(rows);
    const repo = { aggregate } as unknown as UsageEventRepository;
    const svc = new UsageMeterService(repo, fakeLogger());

    expect(svc.aggregate({ eventType: "skill.view" })).toBe(rows);
    expect(aggregate).toHaveBeenCalledWith({ eventType: "skill.view" });
  });

  it("sumQuantity() returns 0 when the repo throws (quota path stays open)", () => {
    const sumQuantity = vi.fn().mockImplementation(() => { throw new Error("db locked"); });
    const repo = { sumQuantity } as unknown as UsageEventRepository;
    const logger = fakeLogger();
    const svc = new UsageMeterService(repo, logger);

    expect(svc.sumQuantity({})).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("list() / deleteOlderThan() delegate verbatim", () => {
    const events: UsageEventEntity[] = [];
    const list = vi.fn().mockReturnValue(events);
    const deleteOlderThan = vi.fn().mockReturnValue(7);
    const repo = { list, deleteOlderThan } as unknown as UsageEventRepository;
    const svc = new UsageMeterService(repo, fakeLogger());

    expect(svc.list({ limit: 10 })).toBe(events);
    expect(list).toHaveBeenCalledWith({ limit: 10 });
    expect(svc.deleteOlderThan(1000)).toBe(7);
    expect(deleteOlderThan).toHaveBeenCalledWith(1000);
  });
});
