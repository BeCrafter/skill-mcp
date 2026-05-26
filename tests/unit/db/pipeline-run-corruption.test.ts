import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "@/db/migrate.js";
import { createDatabase, closeDatabase } from "@/db/connection.js";
import { PipelineRunRepository } from "@/db/repositories/pipeline-run.repository.js";
import { metrics, registry } from "@/telemetry/metrics.js";

/**
 * T-501 — guard against malformed JSON in pipeline_runs columns. Before the
 * fix, any row with corrupt JSON (manual ops surgery, partial write, etc.)
 * would throw a SyntaxError out of findById and propagate to the executor.
 * The fix wraps every JSON.parse, drops the row (returns null), and bumps
 * a per-column counter.
 */
describe("PipelineRunRepository.findById JSON corruption (T-501)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-mcp-pipeline-corrupt-"));
    dbPath = join(dir, "skill-mcp.db");
    runMigrations(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  function getCounter(column: string): number {
    const data = registry.getSingleMetric("skill_mcp_pipeline_runs_row_corrupted_total");
    if (!data) return 0;
    // prom-client Counter exposes .hashMap[labelHash].value
    type Inner = { hashMap: Record<string, { value: number; labels: { column: string } }> };
    const inner = data as unknown as Inner;
    return Object.values(inner.hashMap)
      .filter(e => e.labels.column === column)
      .reduce((sum, e) => sum + e.value, 0);
  }

  it("returns null and increments counter when definitionJson is malformed", () => {
    metrics.pipelineRunRowCorrupted.reset();
    const before = getCounter("definition");

    const sqlite = new Database(dbPath);
    sqlite.prepare(
      `INSERT INTO pipeline_runs (
         id, name, status,
         definition_json, inputs_json, batches_json, completed_stages_json,
         current_batch_index, started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("run-bad", "demo", "running", "not-json", "{}", "[]", "{}", 0, Date.now(), null);
    sqlite.close();

    const db = createDatabase(dbPath);
    const repo = new PipelineRunRepository(db);
    const result = repo.findById("run-bad");

    expect(result).toBeNull();
    expect(getCounter("definition")).toBe(before + 1);
  });

  it("hydrates a well-formed row without bumping the counter", () => {
    metrics.pipelineRunRowCorrupted.reset();

    const db = createDatabase(dbPath);
    const repo = new PipelineRunRepository(db);
    repo.create({
      id: "run-ok",
      name: "demo",
      pipeline: { name: "demo", stages: [] } as never,
      inputs: { foo: 1 },
      batches: [["a"]],
      startedAt: Date.now(),
    });

    const result = repo.findById("run-ok");
    expect(result).not.toBeNull();
    expect(result!.inputs).toEqual({ foo: 1 });
    expect(result!.batches).toEqual([["a"]]);
    expect(getCounter("definition")).toBe(0);
    expect(getCounter("inputs")).toBe(0);
    expect(getCounter("batches")).toBe(0);
    expect(getCounter("completedStages")).toBe(0);
  });

  it("isolates per-column counters when only inputs_json is malformed", () => {
    metrics.pipelineRunRowCorrupted.reset();

    const sqlite = new Database(dbPath);
    sqlite.prepare(
      `INSERT INTO pipeline_runs (
         id, name, status,
         definition_json, inputs_json, batches_json, completed_stages_json,
         current_batch_index, started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("run-inputs-bad", "demo", "running",
      JSON.stringify({ name: "demo", stages: [] }),
      "{not-json",
      "[]", "{}", 0, Date.now(), null,
    );
    sqlite.close();

    const db = createDatabase(dbPath);
    const repo = new PipelineRunRepository(db);
    expect(repo.findById("run-inputs-bad")).toBeNull();
    expect(getCounter("inputs")).toBe(1);
    expect(getCounter("definition")).toBe(0);
  });
});
