import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "@/db/migrate.js";
import { getDatabase, closeDatabase } from "@/db/connection.js";
import { PipelineRunRepository } from "@/db/repositories/pipeline-run.repository.js";
import type { PipelineDefinition } from "@/pipeline/types.js";

describe("PipelineRunRepository — direct surface", () => {
  let dir: string;
  let dbPath: string;
  let repo: PipelineRunRepository;

  const pipeline: PipelineDefinition = {
    name: "p",
    inputs: {},
    stages: { a: { skill: "s", depends_on: [], inputs: {}, outputs: [] } },
    output: {},
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-mcp-piprepo-"));
    dbPath = join(dir, "db.sqlite");
    runMigrations(dbPath);
    repo = new PipelineRunRepository(getDatabase(dbPath));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("create + findById round-trips JSON columns and defaults completedStages={}", () => {
    repo.create({
      id: "run-1",
      name: "p",
      pipeline,
      inputs: { x: 1 },
      batches: [["a"]],
      startedAt: 1000,
    });
    const row = repo.findById("run-1");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("run-1");
    expect(row!.status).toBe("running");
    expect(row!.inputs).toEqual({ x: 1 });
    expect(row!.batches).toEqual([["a"]]);
    expect(row!.completedStages).toEqual({});
    expect(row!.currentBatchIndex).toBe(0);
    expect(row!.finishedAt).toBeNull();
  });

  it("findById returns null for unknown id", () => {
    expect(repo.findById("nope")).toBeNull();
  });

  it("saveCompletedStages persists and round-trips", () => {
    repo.create({ id: "r2", name: "p", pipeline, inputs: {}, batches: [["a"]], startedAt: 0 });
    repo.saveCompletedStages("r2", { a: { result: 42 } });
    expect(repo.findById("r2")!.completedStages).toEqual({ a: { result: 42 } });
  });

  it("updateBatchIndex advances cursor", () => {
    repo.create({ id: "r3", name: "p", pipeline, inputs: {}, batches: [["a"], ["b"]], startedAt: 0 });
    repo.updateBatchIndex("r3", 1);
    expect(repo.findById("r3")!.currentBatchIndex).toBe(1);
  });

  it("updateStatus transitions running → completed with finishedAt", () => {
    repo.create({ id: "r4", name: "p", pipeline, inputs: {}, batches: [["a"]], startedAt: 0 });
    repo.updateStatus("r4", "completed", 12345);
    const row = repo.findById("r4")!;
    expect(row.status).toBe("completed");
    expect(row.finishedAt).toBe(12345);
  });

  it("updateStatus sets finishedAt=null on failure path", () => {
    repo.create({ id: "r5", name: "p", pipeline, inputs: {}, batches: [["a"]], startedAt: 0 });
    repo.updateStatus("r5", "failed", null);
    expect(repo.findById("r5")!.finishedAt).toBeNull();
  });

  it("delete removes the row idempotently", () => {
    repo.create({ id: "r6", name: "p", pipeline, inputs: {}, batches: [["a"]], startedAt: 0 });
    repo.delete("r6");
    expect(repo.findById("r6")).toBeNull();
    // Second delete is a silent no-op
    repo.delete("r6");
  });

  it("deleteOlderThan returns the number of deleted rows and respects cutoff", () => {
    repo.create({ id: "old-1", name: "p", pipeline, inputs: {}, batches: [["a"]], startedAt: 100 });
    repo.create({ id: "old-2", name: "p", pipeline, inputs: {}, batches: [["a"]], startedAt: 200 });
    repo.create({ id: "fresh", name: "p", pipeline, inputs: {}, batches: [["a"]], startedAt: 1000 });
    const deleted = repo.deleteOlderThan(500);
    expect(deleted).toBe(2);
    expect(repo.findById("old-1")).toBeNull();
    expect(repo.findById("old-2")).toBeNull();
    expect(repo.findById("fresh")).not.toBeNull();
  });

  it("deleteOlderThan on empty table returns 0", () => {
    expect(repo.deleteOlderThan(1)).toBe(0);
  });
});
