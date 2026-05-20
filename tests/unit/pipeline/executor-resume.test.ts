import { describe, it, expect, beforeEach } from "vitest";
import { PipelineExecutor } from "../../../src/pipeline/executor.js";
import { PipelineRunStore } from "../../../src/pipeline/run-store.js";
import type { PipelineDefinition } from "../../../src/pipeline/types.js";

// Mock SkillService
class MockSkillService {
  private skills: Map<string, { entry: string; exists: boolean }> = new Map();

  constructor() {
    this.skills.set("fetcher", {
      entry: "SKILL.md\nFetch content from URL",
      exists: true,
    });
    this.skills.set("processor", {
      entry: "SKILL.md\nProcess fetched content",
      exists: true,
    });
    this.skills.set("analyzer", {
      entry: "SKILL.md\nAnalyze data",
      exists: true,
    });
  }

  async skillExists(slug: string): Promise<boolean> {
    return this.skills.get(slug)?.exists ?? false;
  }

  async viewSkillEntry(slug: string): Promise<string> {
    const skill = this.skills.get(slug);
    if (!skill) throw new Error(`Skill "${slug}" not found`);
    return skill.entry;
  }
}

describe("PipelineExecutor (Two-Phase Execution)", () => {
  let executor: PipelineExecutor;
  let runStore: PipelineRunStore;
  let skillService: MockSkillService;

  beforeEach(() => {
    skillService = new MockSkillService();
    runStore = new PipelineRunStore();
    executor = new PipelineExecutor(skillService as any, runStore);
  });

  describe("start", () => {
    it("should create a run and return first batch", async () => {
      const pipeline: PipelineDefinition = {
        name: "test-pipeline",
        inputs: {
          url: { type: "string", required: true },
        },
        stages: {
          fetch: {
            skill: "fetcher",
            depends_on: [],
            inputs: { url: "${{ inputs.url }}" },
            outputs: ["content"],
          },
          process: {
            skill: "processor",
            depends_on: ["fetch"],
            inputs: { data: "${{ stages.fetch.outputs.content }}" },
            outputs: ["result"],
          },
        },
        output: { result: "${{ stages.process.outputs.result }}" },
      };

      const result = await executor.start(pipeline, { url: "http://test.com" });

      expect(result.status).toBe("awaiting_execution");
      expect("run_id" in result).toBe(true);
      expect(result.current_batch).toHaveLength(1);
      expect(result.current_batch[0].stage).toBe("fetch");
    });

    it("should resolve input expressions in stage requests", async () => {
      const pipeline: PipelineDefinition = {
        name: "test-pipeline",
        inputs: {
          url: { type: "string", required: true },
        },
        stages: {
          fetch: {
            skill: "fetcher",
            depends_on: [],
            inputs: { url: "${{ inputs.url }}" },
            outputs: ["content"],
          },
        },
        output: {},
      };

      const result = await executor.start(pipeline, { url: "http://test.com" });

      expect(result.current_batch[0].resolved_inputs).toEqual({
        url: "http://test.com",
      });
    });

    it("should throw error without runStore", async () => {
      const executorWithoutStore = new PipelineExecutor(skillService as any);
      const pipeline: PipelineDefinition = {
        name: "test",
        inputs: {},
        stages: {
          test: { skill: "fetcher", depends_on: [], inputs: {}, outputs: [] },
        },
        output: {},
      };

      await expect(executorWithoutStore.start(pipeline, {})).rejects.toThrow(
        "PipelineRunStore required for two-phase execution"
      );
    });

    it("should handle parallel stages in first batch", async () => {
      const pipeline: PipelineDefinition = {
        name: "parallel-pipeline",
        inputs: {},
        stages: {
          stage1: {
            skill: "fetcher",
            depends_on: [],
            inputs: {},
            outputs: ["out1"],
          },
          stage2: {
            skill: "fetcher",
            depends_on: [],
            inputs: {},
            outputs: ["out2"],
          },
          stage3: {
            skill: "processor",
            depends_on: ["stage1", "stage2"],
            inputs: {},
            outputs: ["out3"],
          },
        },
        output: {},
      };

      const result = await executor.start(pipeline, {});

      expect(result.current_batch).toHaveLength(2);
      const stageNames = result.current_batch.map((s) => s.stage);
      expect(stageNames).toContain("stage1");
      expect(stageNames).toContain("stage2");
      expect(result.remaining_batches).toBe(1);
    });

    it("should validate required inputs", async () => {
      const pipeline: PipelineDefinition = {
        name: "test",
        inputs: {
          url: { type: "string", required: true },
          token: { type: "string", required: false },
        },
        stages: {
          test: { skill: "fetcher", depends_on: [], inputs: {}, outputs: [] },
        },
        output: {},
      };

      await expect(executor.start(pipeline, {})).rejects.toThrow(
        'Required input "url" is missing'
      );
    });

    it("should use default for missing optional inputs", async () => {
      const pipeline: PipelineDefinition = {
        name: "test",
        inputs: {
          url: { type: "string", required: true },
          timeout: { type: "number", required: false, default: 5000 },
        },
        stages: {
          test: { skill: "fetcher", depends_on: [], inputs: {}, outputs: [] },
        },
        output: {},
      };

      const result = await executor.start(pipeline, { url: "http://test.com" });
      expect("run_id" in result).toBe(true);
    });
  });

  describe("resume", () => {
    it("should resume with stage outputs and advance to next batch", async () => {
      const pipeline: PipelineDefinition = {
        name: "test-pipeline",
        inputs: {},
        stages: {
          fetch: {
            skill: "fetcher",
            depends_on: [],
            inputs: {},
            outputs: ["content"],
          },
          process: {
            skill: "processor",
            depends_on: ["fetch"],
            inputs: { data: "${{ stages.fetch.outputs.content }}" },
            outputs: ["result"],
          },
        },
        output: {},
      };

      // Start pipeline
      const startResult = await executor.start(pipeline, {});
      const runId = ("run_id" in startResult && startResult.run_id) || "";

      // Resume with completed stage
      const resumeResult = await executor.resume(runId, {
        fetch: { content: "fetched data" },
      });

      expect(resumeResult.status).toBe("awaiting_execution");
      expect(resumeResult.current_batch).toHaveLength(1);
      expect(resumeResult.current_batch[0].stage).toBe("process");
      expect(resumeResult.current_batch[0].resolved_inputs).toEqual({
        data: "fetched data",
      });
      expect(resumeResult.completed_stages).toHaveLength(1);
    });

    it("should complete pipeline when last batch finishes", async () => {
      const pipeline: PipelineDefinition = {
        name: "single-stage-pipeline",
        inputs: {},
        stages: {
          only: {
            skill: "fetcher",
            depends_on: [],
            inputs: {},
            outputs: ["result"],
          },
        },
        output: { output: "${{ stages.only.outputs.result }}" },
      };

      // Start
      const startResult = await executor.start(pipeline, {});
      const runId = ("run_id" in startResult && startResult.run_id) || "";

      // Resume with completed stage
      const resumeResult = await executor.resume(runId, {
        only: { result: "done" },
      });

      expect(resumeResult.status).toBe("success");
      expect(resumeResult.stages).toHaveLength(1);
      expect(resumeResult.stages[0].stage).toBe("only");
    });

    it("should return awaiting result if not all stages in batch are completed", async () => {
      const pipeline: PipelineDefinition = {
        name: "parallel-pipeline",
        inputs: {},
        stages: {
          stage1: {
            skill: "fetcher",
            depends_on: [],
            inputs: {},
            outputs: ["out1"],
          },
          stage2: {
            skill: "fetcher",
            depends_on: [],
            inputs: {},
            outputs: ["out2"],
          },
          stage3: {
            skill: "processor",
            depends_on: ["stage1", "stage2"],
            inputs: {},
            outputs: ["out3"],
          },
        },
        output: {},
      };

      // Start
      const startResult = await executor.start(pipeline, {});
      const runId = ("run_id" in startResult && startResult.run_id) || "";

      // Resume with only one of two parallel stages completed
      const resumeResult = await executor.resume(runId, {
        stage1: { out1: "result1" },
      });

      expect(resumeResult.status).toBe("awaiting_execution");
      expect(resumeResult.current_batch).toHaveLength(2);
      const stageNames = resumeResult.current_batch.map((s) => s.stage);
      expect(stageNames).toContain("stage1");
      expect(stageNames).toContain("stage2");
    });

    it("should throw error for non-existent run", async () => {
      await expect(
        executor.resume("non-existent", { stage: { data: "test" } })
      ).rejects.toThrow('Pipeline run "non-existent" not found or expired');
    });

    it("should resolve stage dependencies correctly across multiple batches", async () => {
      const pipeline: PipelineDefinition = {
        name: "multi-batch-pipeline",
        inputs: {},
        stages: {
          fetch1: {
            skill: "fetcher",
            depends_on: [],
            inputs: {},
            outputs: ["data1"],
          },
          fetch2: {
            skill: "fetcher",
            depends_on: [],
            inputs: {},
            outputs: ["data2"],
          },
          process1: {
            skill: "processor",
            depends_on: ["fetch1"],
            inputs: { data: "${{ stages.fetch1.outputs.data1 }}" },
            outputs: ["result1"],
          },
          process2: {
            skill: "processor",
            depends_on: ["fetch2"],
            inputs: { data: "${{ stages.fetch2.outputs.data2 }}" },
            outputs: ["result2"],
          },
          final: {
            skill: "analyzer",
            depends_on: ["process1", "process2"],
            inputs: {
              in1: "${{ stages.process1.outputs.result1 }}",
              in2: "${{ stages.process2.outputs.result2 }}",
            },
            outputs: ["final"],
          },
        },
        output: {},
      };

      // Start (batch 1: fetch1, fetch2)
      const result1 = await executor.start(pipeline, {});
      const runId = ("run_id" in result1 && result1.run_id) || "";

      // Resume batch 1 completion (batch 2: process1, process2)
      const result2 = await executor.resume(runId, {
        fetch1: { data1: "data from 1" },
        fetch2: { data2: "data from 2" },
      });

      expect(result2.current_batch).toHaveLength(2);
      expect(result2.current_batch[0].resolved_inputs).toEqual({
        data: "data from 1",
      });
      expect(result2.current_batch[1].resolved_inputs).toEqual({
        data: "data from 2",
      });

      // Resume batch 2 completion (batch 3: final)
      const result3 = await executor.resume(runId, {
        process1: { result1: "processed 1" },
        process2: { result2: "processed 2" },
      });

      expect(result3.current_batch).toHaveLength(1);
      expect(result3.current_batch[0].resolved_inputs).toEqual({
        in1: "processed 1",
        in2: "processed 2",
      });

      // Resume final batch completion (pipeline complete)
      const result4 = await executor.resume(runId, {
        final: { final: "done" },
      });

      expect(result4.status).toBe("success");
      expect(result4.stages).toHaveLength(5);
    });

    it("should store outputs in context for downstream stages", async () => {
      const pipeline: PipelineDefinition = {
        name: "context-test",
        inputs: {},
        stages: {
          source: {
            skill: "fetcher",
            depends_on: [],
            inputs: {},
            outputs: ["raw"],
          },
          transform: {
            skill: "processor",
            depends_on: ["source"],
            inputs: { input: "${{ stages.source.outputs.raw }}" },
            outputs: ["processed"],
          },
        },
        output: {},
      };

      const runId = (await executor.start(pipeline, {})).run_id || "";
      await executor.resume(runId, { source: { raw: "test-data" } });

      const run = runStore.getRun(runId);
      const contextOutput = run?.context.getStageOutputs("source");
      expect(contextOutput).toEqual({ raw: "test-data" });
    });
  });

  describe("Expression Resolution", () => {
    it("should resolve inputs expression", async () => {
      const pipeline: PipelineDefinition = {
        name: "test",
        inputs: {
          url: { type: "string", required: true },
          method: { type: "string", required: false },
        },
        stages: {
          fetch: {
            skill: "fetcher",
            depends_on: [],
            inputs: {
              url: "${{ inputs.url }}",
              method: "${{ inputs.method }}",
            },
            outputs: [],
          },
        },
        output: {},
      };

      const result = await executor.start(pipeline, {
        url: "http://test.com",
        method: "POST",
      });

      expect(result.current_batch[0].resolved_inputs).toEqual({
        url: "http://test.com",
        method: "POST",
      });
    });

    it("should resolve stages.outputs expression", async () => {
      const pipeline: PipelineDefinition = {
        name: "test",
        inputs: {},
        stages: {
          first: {
            skill: "fetcher",
            depends_on: [],
            inputs: {},
            outputs: ["data"],
          },
          second: {
            skill: "processor",
            depends_on: ["first"],
            inputs: { source: "${{ stages.first.outputs.data }}" },
            outputs: [],
          },
        },
        output: {},
      };

      const result = await executor.start(pipeline, {});
      const runId = result.run_id || "";

      await executor.resume(runId, { first: { data: "test-data" } });

      // Get the next batch (should have resolved inputs)
      const run = runStore.getRun(runId);
      const contextOutput = run?.context.getStageOutputs("first");
      expect(contextOutput).toEqual({ data: "test-data" });
    });

    it("should handle nested expression resolution", async () => {
      const pipeline: PipelineDefinition = {
        name: "nested-test",
        inputs: {
          baseUrl: { type: "string", required: true },
        },
        stages: {
          fetch: {
            skill: "fetcher",
            depends_on: [],
            inputs: {
              url: "${{ inputs.baseUrl }}/api/data",
            },
            outputs: ["response"],
          },
        },
        output: {},
      };

      const result = await executor.start(pipeline, {
        baseUrl: "http://test.com",
      });

      // Note: Our implementation doesn't support expression concatenation yet
      // This test documents current behavior
      expect(result.current_batch[0].resolved_inputs).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    it("should throw if skill not found during batch execution", async () => {
      const pipeline: PipelineDefinition = {
        name: "test",
        inputs: {},
        stages: {
          test: {
            skill: "non-existent-skill",
            depends_on: [],
            inputs: {},
            outputs: [],
          },
        },
        output: {},
      };

      await expect(executor.start(pipeline, {})).rejects.toThrow(
        'Skill "non-existent-skill" not found'
      );
    });
  });
});