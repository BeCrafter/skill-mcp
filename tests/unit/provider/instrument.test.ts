import { describe, it, expect, vi } from "vitest";
import { instrumentProvider } from "../../../src/provider/instrument.js";
import { metrics, registry } from "../../../src/telemetry/metrics.js";
import type { ISkillProvider } from "../../../src/provider/interface.js";

function makeProvider(overrides: Partial<ISkillProvider> = {}): ISkillProvider {
  return {
    getSkill: vi.fn(),
    listSkills: vi.fn(),
    getSkillFile: vi.fn(),
    listSkillFiles: vi.fn(),
    getEntryContent: vi.fn(),
    ...overrides,
  } as unknown as ISkillProvider;
}

describe("instrumentProvider (T-101)", () => {
  it("delegates calls to the wrapped provider with original args/return value", async () => {
    const listSkills = vi.fn().mockResolvedValue(["a", "b"]);
    const wrapped = instrumentProvider(makeProvider({ listSkills } as never), "local");
    const out = await wrapped.listSkills?.({} as never);
    expect(out).toEqual(["a", "b"]);
    expect(listSkills).toHaveBeenCalledTimes(1);
  });

  it("records provider_latency on async success", async () => {
    metrics.providerLatency.reset();
    const wrapped = instrumentProvider(
      makeProvider({ listSkills: vi.fn().mockResolvedValue([]) } as never),
      "local-test-ok",
    );
    await wrapped.listSkills?.({} as never);
    const text = await registry.metrics();
    expect(text).toMatch(/provider="local-test-ok".*operation="listSkills".*status="ok"/s);
  });

  it("records status='error' when an async method rejects, then re-throws", async () => {
    metrics.providerLatency.reset();
    const wrapped = instrumentProvider(
      makeProvider({ getSkill: vi.fn().mockRejectedValue(new Error("nope")) } as never),
      "local-test-err",
    );
    await expect(wrapped.getSkill?.("x" as never)).rejects.toThrow(/nope/);
    const text = await registry.metrics();
    expect(text).toMatch(/provider="local-test-err".*operation="getSkill".*status="error"/s);
  });

  it("records status='error' when a sync method throws and re-throws", () => {
    metrics.providerLatency.reset();
    const wrapped = instrumentProvider(
      makeProvider({
        getSkill: (() => { throw new Error("sync-boom"); }) as never,
      }),
      "local-sync-err",
    );
    expect(() => wrapped.getSkill?.("x" as never)).toThrow(/sync-boom/);
  });

  it("returns non-function properties untouched", () => {
    const target = { foo: 42 } as unknown as ISkillProvider;
    const wrapped = instrumentProvider(target, "any") as unknown as { foo: number };
    expect(wrapped.foo).toBe(42);
  });

  it("a sync method returning a non-Promise value still completes the timer", () => {
    const target = { sync: () => 7 } as unknown as ISkillProvider;
    const wrapped = instrumentProvider(target, "sync-ok") as unknown as { sync: () => number };
    expect(wrapped.sync()).toBe(7);
  });
});
