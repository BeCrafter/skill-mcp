import { describe, it, expect } from "vitest";
import { DAGScheduler } from "../../../src/pipeline/dag.js";
import type { StageDefinition } from "../../../src/pipeline/types.js";

function stage(skill: string, depends_on?: string[]): StageDefinition {
  return { skill, inputs: {}, outputs: [], depends_on };
}

describe("DAGScheduler", () => {
  it("returns a single batch when no stages have dependencies", () => {
    const dag = new DAGScheduler({
      a: stage("sa"),
      b: stage("sb"),
      c: stage("sc"),
    });
    const batches = dag.getBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0].sort()).toEqual(["a", "b", "c"]);
  });

  it("layers dependents into successive batches (linear chain)", () => {
    const dag = new DAGScheduler({
      a: stage("sa"),
      b: stage("sb", ["a"]),
      c: stage("sc", ["b"]),
    });
    expect(dag.getBatches()).toEqual([["a"], ["b"], ["c"]]);
  });

  it("packs independent siblings into the same batch (diamond)", () => {
    // a -> {b, c} -> d
    const dag = new DAGScheduler({
      a: stage("sa"),
      b: stage("sb", ["a"]),
      c: stage("sc", ["a"]),
      d: stage("sd", ["b", "c"]),
    });
    const batches = dag.getBatches();
    expect(batches[0]).toEqual(["a"]);
    expect(batches[1].sort()).toEqual(["b", "c"]);
    expect(batches[2]).toEqual(["d"]);
  });

  it("throws on a 2-cycle at construction time (DFS detection)", () => {
    expect(() => new DAGScheduler({
      a: stage("sa", ["b"]),
      b: stage("sb", ["a"]),
    })).toThrow(/Circular dependency/);
  });

  it("throws on a self-loop", () => {
    expect(() => new DAGScheduler({
      a: stage("sa", ["a"]),
    })).toThrow(/Circular dependency/);
  });

  it("throws on a 3-cycle", () => {
    expect(() => new DAGScheduler({
      a: stage("sa", ["c"]),
      b: stage("sb", ["a"]),
      c: stage("sc", ["b"]),
    })).toThrow(/Circular dependency/);
  });

  it("throws when depends_on references an unknown stage", () => {
    expect(() => new DAGScheduler({
      a: stage("sa", ["ghost"]),
    })).toThrow(/depends on unknown stage "ghost"/);
  });

  it("handles an empty stages map", () => {
    const dag = new DAGScheduler({});
    expect(dag.getBatches()).toEqual([]);
  });
});
