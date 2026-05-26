import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../../../src/db/migrate.js";
import { getDatabase, closeDatabase } from "../../../src/db/connection.js";
import { PipelineRunRepository } from "../../../src/db/repositories/pipeline-run.repository.js";
import { PipelineRunStore } from "../../../src/pipeline/run-store.js";
import type { PipelineDefinition } from "../../../src/pipeline/types.js";

describe("PipelineRunStore + DB persistence (T-203)", () => {
  let dir: string;
  let dbPath: string;
  let pipeline: PipelineDefinition;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-mcp-pipeline-"));
    dbPath = join(dir, "skill-mcp.db");
    runMigrations(dbPath);

    pipeline = {
      name: "test-pipeline",
      inputs: { url: { type: "string", required: true } },
      stages: {
        fetch: { skill: "fetcher", depends_on: [], inputs: { url: "${{ inputs.url }}" }, outputs: ["content"] },
        process: { skill: "processor", depends_on: ["fetch"], inputs: { data: "${{ stages.fetch.outputs.content }}" }, outputs: ["result"] },
      },
      output: { result: "${{ stages.process.outputs.result }}" },
    };
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists a run and rehydrates it after the in-memory cache is dropped", () => {
    // Phase 1: create run + complete first stage with a DB-backed store.
    {
      const db = getDatabase(dbPath);
      const store = new PipelineRunStore(new PipelineRunRepository(db));
      const runId = store.createRun(pipeline, { url: "http://example.com" });
      store.completeStage(runId, "fetch", { content: "fetched-data" });
      // Simulate process death: close DB connection without removing the row.
      closeDatabase();

      // Phase 2: fresh process — new DB handle, new store, no in-memory state.
      const db2 = getDatabase(dbPath);
      const store2 = new PipelineRunStore(new PipelineRunRepository(db2));
      const hydrated = store2.getRun(runId);
      expect(hydrated).not.toBeNull();
      expect(hydrated!.runId).toBe(runId);
      expect(hydrated!.pipeline.name).toBe("test-pipeline");
      expect(hydrated!.completedStages.get("fetch")).toEqual({ content: "fetched-data" });
      // ExecutionContext was rebuilt from inputs + replayed completed stages.
      expect(hydrated!.context.getStageOutput("fetch", "content")).toBe("fetched-data");
      // DAGScheduler was reconstructed from pipeline.stages.
      expect(hydrated!.batches).toEqual([["fetch"], ["process"]]);
      expect(hydrated!.currentBatchIndex).toBe(0);
      expect(hydrated!.status).toBe("running");
    }
  });

  it("persists batch advancement and final completion status", () => {
    const db = getDatabase(dbPath);
    const repo = new PipelineRunRepository(db);
    const store = new PipelineRunStore(repo);

    const runId = store.createRun(pipeline, { url: "http://example.com" });
    store.completeStage(runId, "fetch", { content: "x" });
    store.advanceBatch(runId);
    store.completeStage(runId, "process", { result: "done" });
    expect(store.advanceBatch(runId)).toBeNull();

    const record = repo.findById(runId);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("completed");
    expect(record!.currentBatchIndex).toBe(2);
    expect(record!.finishedAt).not.toBeNull();
  });

  it("removeRun deletes the DB row", () => {
    const db = getDatabase(dbPath);
    const repo = new PipelineRunRepository(db);
    const store = new PipelineRunStore(repo);

    const runId = store.createRun(pipeline, { url: "http://example.com" });
    expect(repo.findById(runId)).not.toBeNull();

    store.removeRun(runId);
    expect(repo.findById(runId)).toBeNull();
  });

  it("memory-pressure eviction keeps the DB row so getRun can rehydrate", () => {
    // Regression: enforceMaxRuns previously called repo.delete on the evicted
    // run, which defeated T-203 durability — a resume after eviction would
    // 404 even though the run was within TTL. Eviction must be cache-only.
    const db = getDatabase(dbPath);
    const repo = new PipelineRunRepository(db);
    const store = new PipelineRunStore(repo, { maxRuns: 2 });

    const oldest = store.createRun(pipeline, { url: "http://a" });
    store.createRun(pipeline, { url: "http://b" });
    store.createRun(pipeline, { url: "http://c" });

    // The oldest run was evicted from the in-memory cache, but its DB row
    // must still exist so a future getRun() can rehydrate it.
    expect(repo.findById(oldest)).not.toBeNull();
    const hydrated = store.getRun(oldest);
    expect(hydrated).not.toBeNull();
    expect(hydrated!.runId).toBe(oldest);
  });

  it("TTL expiry deletes from DB on next createRun and getRun returns null", () => {
    vi.useFakeTimers();
    try {
      const db = getDatabase(dbPath);
      const repo = new PipelineRunRepository(db);
      const store = new PipelineRunStore(repo);

      const runId = store.createRun(pipeline, { url: "http://example.com" });
      vi.advanceTimersByTime(31 * 60 * 1000);

      // Drop in-memory cache to force DB hydration path.
      const store2 = new PipelineRunStore(repo);
      expect(store2.getRun(runId)).toBeNull();
      expect(repo.findById(runId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
