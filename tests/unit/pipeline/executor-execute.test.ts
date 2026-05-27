import { describe, it, expect } from "vitest";
import { PipelineExecutor } from "@/pipeline/executor.js";
import type { PipelineDefinition } from "@/pipeline/types.js";

class FakeSkillService {
  constructor(private failOn: Set<string> = new Set()) {}
  async skillExists(slug: string): Promise<boolean> {
    return !this.failOn.has(slug);
  }
  async viewSkillEntry(slug: string): Promise<string> {
    if (this.failOn.has(slug)) throw new Error(`boom:${slug}`);
    return `entry:${slug}`;
  }
}

describe("PipelineExecutor.execute (single-shot mode)", () => {
  it("throws when a required input is missing and has no default", async () => {
    const pipeline: PipelineDefinition = {
      name: "p",
      inputs: { topic: { type: "string", required: true } },
      stages: { a: { skill: "s", depends_on: [], inputs: {}, outputs: [] } },
      output: {},
    };
    const exec = new PipelineExecutor(new FakeSkillService() as never);
    await expect(exec.execute(pipeline, {})).rejects.toThrow(/Required input "topic"/);
  });

  it("substitutes default for required input when missing", async () => {
    const pipeline: PipelineDefinition = {
      name: "p",
      inputs: { topic: { type: "string", required: true, default: "hello" } },
      stages: { a: { skill: "s", depends_on: [], inputs: { t: "${{ inputs.topic }}" }, outputs: [] } },
      output: { topic: "${{ inputs.topic }}" },
    };
    const exec = new PipelineExecutor(new FakeSkillService() as never);
    const inputs: Record<string, unknown> = {};
    const result = await exec.execute(pipeline, inputs);
    expect(inputs.topic).toBe("hello");
    expect(result.status).toBe("success");
    expect(result.output.topic).toBe("hello");
  });

  it("returns status=success when all stages pass", async () => {
    const pipeline: PipelineDefinition = {
      name: "p",
      inputs: {},
      stages: {
        a: { skill: "skill-a", depends_on: [], inputs: {}, outputs: [] },
        b: { skill: "skill-b", depends_on: ["a"], inputs: {}, outputs: [] },
      },
      output: {},
    };
    const exec = new PipelineExecutor(new FakeSkillService() as never);
    const result = await exec.execute(pipeline, {});
    expect(result.status).toBe("success");
    expect(result.stages).toHaveLength(2);
    expect(result.stages.every(s => s.status === "success")).toBe(true);
    expect(result.total_duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("marks status=partial and short-circuits subsequent batches on failure", async () => {
    const pipeline: PipelineDefinition = {
      name: "p",
      inputs: {},
      stages: {
        a: { skill: "good-a", depends_on: [], inputs: {}, outputs: [] },
        b: { skill: "missing-b", depends_on: [], inputs: {}, outputs: [] },
        c: { skill: "good-c", depends_on: ["a", "b"], inputs: {}, outputs: [] },
      },
      output: {},
    };
    const exec = new PipelineExecutor(new FakeSkillService(new Set(["missing-b"])) as never);
    const result = await exec.execute(pipeline, {});
    expect(result.status).toBe("partial");
    const stageNames = result.stages.map(s => s.stage);
    expect(stageNames).toContain("a");
    expect(stageNames).toContain("b");
    expect(stageNames).not.toContain("c");
    const failed = result.stages.find(s => s.stage === "b")!;
    expect(failed.status).toBe("failure");
    expect(failed.error).toMatch(/not found|boom/);
  });

  it("captures rejection from executeStage with duration_ms=0 and error message", async () => {
    const failing = {
      async skillExists() { return true; },
      async viewSkillEntry() { throw new Error("downstream-fail"); },
    };
    const pipeline: PipelineDefinition = {
      name: "p",
      inputs: {},
      stages: { a: { skill: "x", depends_on: [], inputs: {}, outputs: [] } },
      output: {},
    };
    const exec = new PipelineExecutor(failing as never);
    const result = await exec.execute(pipeline, {});
    expect(result.status).toBe("partial");
    const a = result.stages[0];
    expect(a.status).toBe("failure");
    expect(a.error).toBe("downstream-fail");
  });

  it("resolves output expressions from stage outputs", async () => {
    const pipeline: PipelineDefinition = {
      name: "p",
      inputs: { name: { type: "string", required: false } },
      stages: { a: { skill: "skill-a", depends_on: [], inputs: { v: "${{ inputs.name }}" }, outputs: [] } },
      output: { who: "${{ inputs.name }}" },
    };
    const exec = new PipelineExecutor(new FakeSkillService() as never);
    const result = await exec.execute(pipeline, { name: "Ada" });
    expect(result.output.who).toBe("Ada");
  });
});
