import crypto from "node:crypto";
import type { PipelineDefinition } from "./types.js";
import { ExecutionContext } from "./context.js";
import { DAGScheduler } from "./dag.js";

export interface PipelineRun {
  runId: string;
  pipeline: PipelineDefinition;
  inputs: Record<string, unknown>;
  context: ExecutionContext;
  dag: DAGScheduler;
  batches: string[][];
  currentBatchIndex: number;
  completedStages: Map<string, Record<string, unknown>>;
  status: "running" | "completed" | "failed";
  createdAt: number;
}

export class PipelineRunStore {
  private runs: Map<string, PipelineRun> = new Map();
  private readonly TTL = 30 * 60 * 1000; // 30 minutes

  createRun(pipeline: PipelineDefinition, inputs: Record<string, unknown>): string {
    const runId = crypto.randomUUID();
    const context = new ExecutionContext(inputs);
    const dag = new DAGScheduler(pipeline.stages);
    const batches = dag.getBatches();
    const run: PipelineRun = {
      runId,
      pipeline,
      inputs,
      context,
      dag,
      batches,
      currentBatchIndex: 0,
      completedStages: new Map(),
      status: "running",
      createdAt: Date.now(),
    };
    this.runs.set(runId, run);
    this.cleanup();
    return runId;
  }

  getRun(runId: string): PipelineRun | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (Date.now() - run.createdAt > this.TTL) {
      this.runs.delete(runId);
      return null;
    }
    return run;
  }

  completeStage(runId: string, stageName: string, outputs: Record<string, unknown>): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.completedStages.set(stageName, outputs);
    run.context.setStageOutputs(stageName, outputs);
  }

  advanceBatch(runId: string): string[] | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.currentBatchIndex++;
    if (run.currentBatchIndex >= run.batches.length) {
      run.status = "completed";
      return null;
    }
    return run.batches[run.currentBatchIndex];
  }

  removeRun(runId: string): void {
    this.runs.delete(runId);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [runId, run] of this.runs.entries()) {
      if (now - run.createdAt > this.TTL) {
        this.runs.delete(runId);
      }
    }
  }
}
