import { eq, lt } from "drizzle-orm";
import type { DrizzleDB } from "../connection.js";
import { pipelineRuns } from "../schema.js";
import type { PipelineDefinition } from "../../pipeline/types.js";
import { metrics } from "../../telemetry/metrics.js";
import { getLogger } from "../../utils/logger.js";

export interface PipelineRunRecord {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  pipeline: PipelineDefinition;
  inputs: Record<string, unknown>;
  batches: string[][];
  completedStages: Record<string, Record<string, unknown>>;
  currentBatchIndex: number;
  startedAt: number;
  finishedAt: number | null;
}

export interface PipelineRunCreate {
  id: string;
  name: string;
  pipeline: PipelineDefinition;
  inputs: Record<string, unknown>;
  batches: string[][];
  startedAt: number;
}

function parseRunJson<T>(column: string, raw: string, runId: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    metrics.pipelineRunRowCorrupted.inc({ column });
    getLogger().warn(
      { err, runId, column },
      "pipeline_runs row dropped: JSON column failed to parse",
    );
    return null;
  }
}

export class PipelineRunRepository {
  constructor(private db: DrizzleDB) {}

  create(input: PipelineRunCreate): void {
    this.db.insert(pipelineRuns).values({
      id: input.id,
      name: input.name,
      status: "running",
      definitionJson: JSON.stringify(input.pipeline),
      inputsJson: JSON.stringify(input.inputs),
      batchesJson: JSON.stringify(input.batches),
      completedStagesJson: "{}",
      currentBatchIndex: 0,
      startedAt: input.startedAt,
      finishedAt: null,
    }).run();
  }

  findById(id: string): PipelineRunRecord | null {
    const row = this.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).limit(1).all()[0];
    if (!row) return null;
    const pipeline = parseRunJson<PipelineDefinition>("definition", row.definitionJson, id);
    const inputs = parseRunJson<Record<string, unknown>>("inputs", row.inputsJson, id);
    const batches = parseRunJson<string[][]>("batches", row.batchesJson, id);
    const completedStages = parseRunJson<Record<string, Record<string, unknown>>>(
      "completedStages",
      row.completedStagesJson,
      id,
    );
    if (!pipeline || !inputs || !batches || !completedStages) return null;
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      pipeline,
      inputs,
      batches,
      completedStages,
      currentBatchIndex: row.currentBatchIndex,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  saveCompletedStages(id: string, completedStages: Record<string, Record<string, unknown>>): void {
    this.db.update(pipelineRuns)
      .set({ completedStagesJson: JSON.stringify(completedStages) })
      .where(eq(pipelineRuns.id, id))
      .run();
  }

  updateBatchIndex(id: string, currentBatchIndex: number): void {
    this.db.update(pipelineRuns)
      .set({ currentBatchIndex })
      .where(eq(pipelineRuns.id, id))
      .run();
  }

  updateStatus(id: string, status: "running" | "completed" | "failed", finishedAt: number | null): void {
    this.db.update(pipelineRuns)
      .set({ status, finishedAt })
      .where(eq(pipelineRuns.id, id))
      .run();
  }

  delete(id: string): void {
    this.db.delete(pipelineRuns).where(eq(pipelineRuns.id, id)).run();
  }

  deleteOlderThan(cutoff: number): number {
    const result = this.db.delete(pipelineRuns).where(lt(pipelineRuns.startedAt, cutoff)).run();
    return result.changes ?? 0;
  }
}
