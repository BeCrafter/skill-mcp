import crypto from "node:crypto";
import type { PipelineDefinition } from "./types.js";
import { ExecutionContext } from "./context.js";
import { DAGScheduler } from "./dag.js";
import type { PipelineRunRepository } from "../db/repositories/pipeline-run.repository.js";

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

/**
 * Persistent run store (T-203).
 *
 * In-memory cache + optional DB-backed repository. When a `repo` is provided,
 * runs are written through to SQLite so a long-running pipeline survives
 * process restart — clients can still call `skill_pipeline.resume({ run_id })`
 * after a daemon kill. With no repo, the store is purely in-memory (used by
 * existing unit tests and any caller that doesn't want durability).
 */
export interface PipelineRunStoreOptions {
  /** Hard cap on concurrent in-memory runs. Excess runs are evicted oldest-first
   *  (insertion-order LRU via Map iteration). Default 10000. */
  maxRuns?: number;
}

export class PipelineRunStore {
  private runs: Map<string, PipelineRun> = new Map();
  private readonly TTL = 30 * 60 * 1000; // 30 minutes
  private readonly repo?: PipelineRunRepository;
  // T-710 — TTL alone left the store unbounded; a burst of `start` calls
  // within the 30-minute window could pin arbitrarily many runs in memory.
  private readonly maxRuns: number;

  constructor(repo?: PipelineRunRepository, options?: PipelineRunStoreOptions) {
    this.repo = repo;
    this.maxRuns = options?.maxRuns ?? 10000;
  }

  createRun(pipeline: PipelineDefinition, inputs: Record<string, unknown>): string {
    const runId = crypto.randomUUID();
    const dag = new DAGScheduler(pipeline.stages);
    const batches = dag.getBatches();
    const startedAt = Date.now();
    const run: PipelineRun = {
      runId,
      pipeline,
      inputs,
      context: new ExecutionContext(inputs),
      dag,
      batches,
      currentBatchIndex: 0,
      completedStages: new Map(),
      status: "running",
      createdAt: startedAt,
    };
    this.runs.set(runId, run);
    if (this.repo) {
      this.repo.create({ id: runId, name: pipeline.name, pipeline, inputs, batches, startedAt });
    }
    this.cleanup();
    this.enforceMaxRuns();
    return runId;
  }

  // T-710 — JS Map preserves insertion order, so the first iterated key is the
  // oldest. Evict in-memory entries only; durability is the whole point of
  // the repo, so a memory-pressure eviction must never drop the DB row —
  // `getRun` will rehydrate from the repo on next access. TTL-based DB GC
  // happens in `cleanup()` via `deleteOlderThan`.
  private enforceMaxRuns(): void {
    while (this.runs.size > this.maxRuns) {
      const oldest = this.runs.keys().next().value;
      if (!oldest) break;
      this.runs.delete(oldest);
    }
  }

  getRun(runId: string): PipelineRun | null {
    const cached = this.runs.get(runId);
    if (cached) {
      if (Date.now() - cached.createdAt > this.TTL) {
        this.runs.delete(runId);
        if (this.repo) this.repo.delete(runId);
        return null;
      }
      return cached;
    }

    if (!this.repo) return null;

    const record = this.repo.findById(runId);
    if (!record) return null;
    if (Date.now() - record.startedAt > this.TTL) {
      this.repo.delete(runId);
      return null;
    }

    const dag = new DAGScheduler(record.pipeline.stages);
    const context = new ExecutionContext(record.inputs);
    const completedStages = new Map<string, Record<string, unknown>>();
    for (const [stageName, outputs] of Object.entries(record.completedStages)) {
      completedStages.set(stageName, outputs);
      context.setStageOutputs(stageName, outputs);
    }
    const hydrated: PipelineRun = {
      runId: record.id,
      pipeline: record.pipeline,
      inputs: record.inputs,
      context,
      dag,
      batches: record.batches,
      currentBatchIndex: record.currentBatchIndex,
      completedStages,
      status: record.status,
      createdAt: record.startedAt,
    };
    this.runs.set(runId, hydrated);
    return hydrated;
  }

  completeStage(runId: string, stageName: string, outputs: Record<string, unknown>): void {
    const run = this.getRun(runId);
    if (!run) return;
    run.completedStages.set(stageName, outputs);
    run.context.setStageOutputs(stageName, outputs);
    if (this.repo) {
      this.repo.saveCompletedStages(runId, Object.fromEntries(run.completedStages));
    }
  }

  advanceBatch(runId: string): string[] | null {
    const run = this.getRun(runId);
    if (!run) return null;
    run.currentBatchIndex++;
    if (run.currentBatchIndex >= run.batches.length) {
      run.status = "completed";
      if (this.repo) {
        this.repo.updateBatchIndex(runId, run.currentBatchIndex);
        this.repo.updateStatus(runId, "completed", Date.now());
      }
      return null;
    }
    if (this.repo) {
      this.repo.updateBatchIndex(runId, run.currentBatchIndex);
    }
    return run.batches[run.currentBatchIndex];
  }

  removeRun(runId: string): void {
    this.runs.delete(runId);
    if (this.repo) this.repo.delete(runId);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [runId, run] of this.runs.entries()) {
      if (now - run.createdAt > this.TTL) {
        this.runs.delete(runId);
      }
    }
    if (this.repo) {
      this.repo.deleteOlderThan(now - this.TTL);
    }
  }
}
