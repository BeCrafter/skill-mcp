import { describe, it, expect } from "vitest";
import { PipelineExecutor } from "../../../src/pipeline/executor.js";
import { PipelineRunStore } from "../../../src/pipeline/run-store.js";
import type { PipelineDefinition } from "../../../src/pipeline/types.js";

/**
 * T-709 — two callers concurrently completing the last missing stages of a
 * batch must not both observe `allCompleted=true` and both call
 * `advanceBatch`. Without per-runId serialization, the second call would
 * skip an entire batch, dropping its outputs from downstream stages.
 */
class StubSkillService {
  async skillExists(): Promise<boolean> {
    return true;
  }
  async viewSkillEntry(slug: string): Promise<string> {
    return `entry:${slug}`;
  }
}

describe("PipelineExecutor.resume concurrency (T-709)", () => {
  it("does not skip a batch when two callers complete the last stages in parallel", async () => {
    const pipeline: PipelineDefinition = {
      name: "race",
      inputs: {},
      stages: {
        a: { skill: "skill-a", depends_on: [], inputs: {}, outputs: ["x"] },
        b: { skill: "skill-b", depends_on: [], inputs: {}, outputs: ["y"] },
        c: { skill: "skill-c", depends_on: ["a", "b"], inputs: {}, outputs: ["z"] },
      },
      output: {},
    };

    const runStore = new PipelineRunStore();
    const executor = new PipelineExecutor(new StubSkillService() as never, runStore);

    const startResp = await executor.start(pipeline, {});
    expect(startResp.status).toBe("awaiting_execution");
    const runId = (startResp as { run_id: string }).run_id;

    // Two parallel resume() calls — one supplying outputs for stage `a`, the
    // other for stage `b`. Pre-fix, both would see allCompleted=true and
    // both call advanceBatch, jumping past batch[1] (just stage `c`).
    const [r1, r2] = await Promise.all([
      executor.resume(runId, { a: { x: 1 } }),
      executor.resume(runId, { b: { y: 2 } }),
    ]);

    // Whichever call lands second observes both stages done and advances
    // exactly once. The pipeline must now be awaiting batch[1] = ["c"].
    const responses = [r1, r2];
    const advanced = responses.find(
      (r) =>
        r.status === "awaiting_execution" &&
        (r as { current_batch: { stage: string }[] }).current_batch.some((s) => s.stage === "c"),
    );
    expect(advanced, "exactly one resume() must advance to batch[1]").toBeDefined();

    // The other response either still shows batch[0] (the first call ran
    // before the second's outputs were recorded) — both are valid as long
    // as neither one skips batch[1] entirely.
    const skipped = responses.find(
      (r) => r.status === "success" || r.status === "partial" || r.status === "failure",
    );
    expect(skipped, "resume must not jump straight to terminal status").toBeUndefined();
  });
});
