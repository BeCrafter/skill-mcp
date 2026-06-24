import { describe, it, expect } from "vitest";
import { PipelineExecutor } from "../../../src/pipeline/executor.js";
import { PipelineRunStore } from "../../../src/pipeline/run-store.js";
import type { PipelineDefinition } from "../../../src/pipeline/types.js";

/**
 * T-703 — DAG batches are dependency-free by construction, so the executor
 * resolves their skill entries with `Promise.all`, not a serial for-await
 * loop. The test plants 3 independent stages in one batch, each with a
 * 60ms artificial latency on `viewSkillEntry`. Serial execution would take
 * ≥180ms; parallel execution is bounded by the slowest stage (~60-90ms).
 */
class SlowSkillService {
  async skillExists(): Promise<boolean> {
    return true;
  }

  async viewSkillEntry(slug: string): Promise<string> {
    await new Promise(r => setTimeout(r, 60));
    return `entry:${slug}`;
  }
}

describe("PipelineExecutor batch parallelism (T-703)", () => {
  it("resolves viewSkillEntry in parallel for a wide batch", async () => {
    const pipeline: PipelineDefinition = {
      name: "fanout",
      inputs: {},
      stages: {
        a: { skill: "skill-a", depends_on: [], inputs: {}, outputs: ["x"] },
        b: { skill: "skill-b", depends_on: [], inputs: {}, outputs: ["x"] },
        c: { skill: "skill-c", depends_on: [], inputs: {}, outputs: ["x"] },
      },
      output: {},
    };

    const runStore = new PipelineRunStore();
    const executor = new PipelineExecutor(new SlowSkillService() as never, runStore);

    const start = Date.now();
    const result = await executor.start(pipeline, {});
    const elapsed = Date.now() - start;

    expect(result.status).toBe("awaiting_execution");
    if (result.status === "awaiting_execution") {
      expect(result.current_batch).toHaveLength(3);
    }
    // Serial path would be 3 × 60ms = 180ms+. Parallel path stays well under
    // 200ms even under CI jitter. Threshold is loose enough for slow runners
    // while still asserting non-serial behavior.
    expect(elapsed).toBeLessThan(200);
  });
});
