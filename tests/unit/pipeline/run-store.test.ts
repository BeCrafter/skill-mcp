import { describe, it, expect, beforeEach, vi } from "vitest";
import { PipelineRunStore } from "../../../src/pipeline/run-store.js";
import type { PipelineDefinition } from "../../../src/pipeline/types.js";

describe("PipelineRunStore", () => {
  let runStore: PipelineRunStore;
  let mockPipeline: PipelineDefinition;

  beforeEach(() => {
    runStore = new PipelineRunStore();
    mockPipeline = {
      name: "test-pipeline",
      inputs: {
        url: { type: "string", required: true },
      },
      stages: {
        fetch: {
          skill: "fetcher",
          depends_on: [],
          inputs: { url: "http://example.com" },
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
  });

  describe("createRun", () => {
    it("should create a new pipeline run with a unique runId", async () => {
      const inputs = { url: "http://test.com" };
      const runId1 = await runStore.createRun(mockPipeline, inputs);
      const runId2 = await runStore.createRun(mockPipeline, inputs);

      expect(runId1).toBeDefined();
      expect(runId2).toBeDefined();
      expect(runId1).not.toBe(runId2);
    });

    it("should initialize run with correct state", async () => {
      const inputs = { url: "http://test.com" };
      const runId = await runStore.createRun(mockPipeline, inputs);
      const run = runStore.getRun(runId);

      expect(run).not.toBeNull();
      expect(run!.runId).toBe(runId);
      expect(run!.pipeline).toEqual(mockPipeline);
      expect(run!.inputs).toEqual(inputs);
      expect(run!.currentBatchIndex).toBe(0);
      expect(run!.status).toBe("running");
      expect(run!.completedStages.size).toBe(0);
    });

    it("should calculate batches based on stage dependencies", async () => {
      const runId = await runStore.createRun(mockPipeline, { url: "http://test.com" });
      const run = runStore.getRun(runId);

      expect(run!.batches).toHaveLength(2);
      expect(run!.batches[0]).toEqual(["fetch"]);
      expect(run!.batches[1]).toEqual(["process"]);
    });
  });

  describe("getRun", () => {
    it("should return null for non-existent run", () => {
      const run = runStore.getRun("non-existent");
      expect(run).toBeNull();
    });

    it("should return the run when it exists", async () => {
      const runId = await runStore.createRun(mockPipeline, { url: "http://test.com" });
      const run = runStore.getRun(runId);

      expect(run).not.toBeNull();
      expect(run!.runId).toBe(runId);
    });

    it("should return null for expired runs (TTL check)", async () => {
      vi.useFakeTimers();
      const runId = await runStore.createRun(mockPipeline, { url: "http://test.com" });

      // Advance time past TTL (30 minutes)
      vi.advanceTimersByTime(31 * 60 * 1000);

      const run = runStore.getRun(runId);
      expect(run).toBeNull();

      vi.useRealTimers();
    });
  });

  describe("completeStage", () => {
    it("should store stage outputs", async () => {
      const runId = await runStore.createRun(mockPipeline, { url: "http://test.com" });
      const outputs = { content: "test content" };

      runStore.completeStage(runId, "fetch", outputs);
      const run = runStore.getRun(runId);

      expect(run!.completedStages.has("fetch")).toBe(true);
      expect(run!.completedStages.get("fetch")).toEqual(outputs);
    });

    it("should update context with stage outputs", async () => {
      const runId = await runStore.createRun(mockPipeline, { url: "http://test.com" });
      const outputs = { content: "test content" };

      runStore.completeStage(runId, "fetch", outputs);
      const run = runStore.getRun(runId);

      const stageOutput = run!.context.getStageOutputs("fetch");
      expect(stageOutput).toEqual(outputs);
    });

    it("should not throw when completing stage on non-existent run", () => {
      expect(() => {
        runStore.completeStage("non-existent", "fetch", { data: "test" });
      }).not.toThrow();
    });
  });

  describe("advanceBatch", () => {
    it("should advance to next batch and return stage names", async () => {
      const runId = await runStore.createRun(mockPipeline, { url: "http://test.com" });
      const nextBatch = runStore.advanceBatch(runId);
      const run = runStore.getRun(runId);

      expect(nextBatch).toEqual(["process"]);
      expect(run!.currentBatchIndex).toBe(1);
    });

    it("should return null and mark as completed when advancing past last batch", async () => {
      const runId = await runStore.createRun(mockPipeline, { url: "http://test.com" });

      // Advance past all batches
      const batch1 = runStore.advanceBatch(runId);
      expect(batch1).toEqual(["process"]);

      const batch2 = runStore.advanceBatch(runId);
      expect(batch2).toBeNull();

      const run = runStore.getRun(runId);
      expect(run!.status).toBe("completed");
    });

    it("should return null for non-existent run", () => {
      const nextBatch = runStore.advanceBatch("non-existent");
      expect(nextBatch).toBeNull();
    });
  });

  describe("removeRun", () => {
    it("should remove a run from the store", async () => {
      const runId = await runStore.createRun(mockPipeline, { url: "http://test.com" });

      runStore.removeRun(runId);
      const run = runStore.getRun(runId);

      expect(run).toBeNull();
    });

    it("should not throw when removing non-existent run", () => {
      expect(() => {
        runStore.removeRun("non-existent");
      }).not.toThrow();
    });
  });

  describe("cleanup", () => {
    it("should automatically clean up expired runs on createRun", async () => {
      vi.useFakeTimers();

      // Create first run
      const runId1 = await runStore.createRun(mockPipeline, { url: "http://test.com" });

      // Advance time to 20 minutes
      vi.advanceTimersByTime(20 * 60 * 1000);

      // Create second run (triggers cleanup, but first run is still valid)
      const runId2 = await runStore.createRun(mockPipeline, { url: "http://test.com" });

      expect(runStore.getRun(runId1)).not.toBeNull();
      expect(runStore.getRun(runId2)).not.toBeNull();

      // Advance past TTL (31 minutes total)
      vi.advanceTimersByTime(11 * 60 * 1000);

      // Create third run (triggers cleanup, first run should be removed)
      const runId3 = await runStore.createRun(mockPipeline, { url: "http://test.com" });

      expect(runStore.getRun(runId1)).toBeNull(); // Expired
      expect(runStore.getRun(runId2)).not.toBeNull(); // Still valid (only 11 min old)
      expect(runStore.getRun(runId3)).not.toBeNull(); // New run

      vi.useRealTimers();
    });

    it("should not affect active runs during cleanup", async () => {
      vi.useFakeTimers();

      // Create multiple runs
      const runIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        runIds.push(await runStore.createRun(mockPipeline, { url: `http://test${i}.com` }));
      }

      // Advance to 25 minutes (all runs still valid)
      vi.advanceTimersByTime(25 * 60 * 1000);

      // Trigger cleanup by creating new run
      await runStore.createRun(mockPipeline, { url: "http://new.com" });

      // All original runs should still exist
      for (const runId of runIds) {
        expect(runStore.getRun(runId)).not.toBeNull();
      }

      vi.useRealTimers();
    });
  });

  describe("completeStage + advanceBatch workflow", () => {
    it("should support the complete-then-advance pattern", async () => {
      const runId = await runStore.createRun(mockPipeline, { url: "http://test.com" });
      const outputs = { content: "fetched data" };

      // Complete first stage
      runStore.completeStage(runId, "fetch", outputs);

      // Verify stage is marked as complete
      const run = runStore.getRun(runId);
      expect(run!.completedStages.has("fetch")).toBe(true);

      // Advance to next batch
      const nextBatch = runStore.advanceBatch(runId);
      expect(nextBatch).toEqual(["process"]);

      // Verify batch index advanced
      const updatedRun = runStore.getRun(runId);
      expect(updatedRun!.currentBatchIndex).toBe(1);
    });

    it("should allow completing multiple stages in same batch", async () => {
      // Create pipeline with two independent stages
      const parallelPipeline: PipelineDefinition = {
        name: "parallel-pipeline",
        inputs: {},
        stages: {
          stage1: {
            skill: "skill1",
            depends_on: [],
            inputs: {},
            outputs: ["out1"],
          },
          stage2: {
            skill: "skill2",
            depends_on: [],
            inputs: {},
            outputs: ["out2"],
          },
          stage3: {
            skill: "skill3",
            depends_on: ["stage1", "stage2"],
            inputs: {},
            outputs: ["out3"],
          },
        },
        output: {},
      };

      const runId = await runStore.createRun(parallelPipeline, {});

      // Complete both stages in first batch
      runStore.completeStage(runId, "stage1", { out1: "result1" });
      runStore.completeStage(runId, "stage2", { out2: "result2" });

      const run = runStore.getRun(runId);
      expect(run!.completedStages.size).toBe(2);

      // Advance should work
      const nextBatch = runStore.advanceBatch(runId);
      expect(nextBatch).toEqual(["stage3"]);
    });
  });
});