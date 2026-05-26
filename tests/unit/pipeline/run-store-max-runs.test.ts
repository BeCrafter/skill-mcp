import { describe, it, expect } from "vitest";
import { PipelineRunStore } from "../../../src/pipeline/run-store.js";
import type { PipelineDefinition } from "../../../src/pipeline/types.js";

/**
 * T-710 — TTL alone left the store unbounded; cap concurrent in-memory runs
 * with insertion-order LRU eviction so a burst of `start` calls cannot OOM
 * the process within the 30-min TTL window.
 */
describe("PipelineRunStore maxRuns (T-710)", () => {
  const pipeline: PipelineDefinition = {
    name: "p",
    inputs: {},
    stages: {
      a: { skill: "skill-a", depends_on: [], inputs: {}, outputs: ["x"] },
    },
    output: {},
  };

  it("evicts oldest runs when count exceeds maxRuns", () => {
    const store = new PipelineRunStore(undefined, { maxRuns: 3 });
    const ids = [
      store.createRun(pipeline, {}),
      store.createRun(pipeline, {}),
      store.createRun(pipeline, {}),
      store.createRun(pipeline, {}),
      store.createRun(pipeline, {}),
    ];

    expect(store.getRun(ids[0])).toBeNull();
    expect(store.getRun(ids[1])).toBeNull();
    expect(store.getRun(ids[2])).not.toBeNull();
    expect(store.getRun(ids[3])).not.toBeNull();
    expect(store.getRun(ids[4])).not.toBeNull();
  });

  it("defaults to a generous maxRuns and does not evict in normal usage", () => {
    const store = new PipelineRunStore();
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) ids.push(store.createRun(pipeline, {}));
    for (const id of ids) expect(store.getRun(id)).not.toBeNull();
  });
});
