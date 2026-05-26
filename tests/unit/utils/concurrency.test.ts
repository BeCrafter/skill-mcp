import { describe, it, expect } from "vitest";
import { pMap } from "../../../src/utils/concurrency.js";

describe("pMap (T-725 — storage concurrency cap)", () => {
  it("never runs more than `concurrency` workers in flight at once", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;

    await pMap(items, 8, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });

    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  it("preserves input order in the output", async () => {
    const items = [10, 20, 30, 40];
    const result = await pMap(items, 2, async (n) => {
      await new Promise((r) => setTimeout(r, n % 30));
      return n * 2;
    });
    expect(result).toEqual([20, 40, 60, 80]);
  });

  it("short-circuits on empty input", async () => {
    const result = await pMap([], 8, async () => "x");
    expect(result).toEqual([]);
  });
});
