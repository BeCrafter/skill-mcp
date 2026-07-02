import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { SkillRepository } from "../../../src/db/repositories/skill.repository.js";
import { SkillEvalRepository } from "../../../src/db/repositories/skill-eval.repository.js";
import { EvalRunner, evaluateExpectations } from "../../../src/eval/runner.js";
import { EchoEvalProvider } from "../../../src/eval/echo-provider.js";
import type { EvalProvider, EvalProviderResult, EvalInput } from "../../../src/eval/provider.interface.js";
import { SkillNotFoundError } from "../../../src/utils/errors.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

/**
 * P1-12 stage 2 — EvalRunner contract pins:
 *   - evaluateExpectations: ALL semantics for contains; NONE for not-contains.
 *   - runForSlug: persists one row per case; produces RunSummary with right tallies.
 *   - Provider throw → status="error", failureReason populated, run continues.
 *   - Unknown slug → SkillNotFoundError.
 */

function createTestTables(db: DrizzleDB): void {
  const statements = [
    `CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      display_name TEXT, description TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '0.0.1', category TEXT DEFAULT NULL,
      attributes TEXT, retrieval_meta TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      visibility TEXT NOT NULL DEFAULT 'private', entry_file TEXT DEFAULT 'SKILL.md',
      storage_path TEXT NOT NULL, content_hash TEXT,
      import_source TEXT, import_url TEXT, import_branch TEXT, import_sub_dir TEXT, imported_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS skill_tags (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (skill_id, tag)
    )`,
    `CREATE TABLE IF NOT EXISTS skill_eval_cases (
      id TEXT PRIMARY KEY NOT NULL,
      skill_id TEXT NOT NULL,
      case_name TEXT NOT NULL,
      input TEXT NOT NULL,
      expectations_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uk_skill_eval_cases_skill_case ON skill_eval_cases(skill_id, case_name)`,
    `CREATE TABLE IF NOT EXISTS skill_eval_runs (
      id TEXT PRIMARY KEY NOT NULL,
      skill_id TEXT NOT NULL,
      skill_version TEXT NOT NULL,
      case_name TEXT NOT NULL,
      status TEXT NOT NULL,
      runner TEXT NOT NULL DEFAULT 'stub',
      tools_used_json TEXT,
      output TEXT,
      failure_reason TEXT,
      latency_ms INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
    )`,
  ];
  for (const sql of statements) db.run(sql);
}

class StubProvider implements EvalProvider {
  readonly name = "stub";
  constructor(private fn: (input: EvalInput) => Promise<EvalProviderResult> | EvalProviderResult) {}
  async run(input: EvalInput): Promise<EvalProviderResult> {
    return await this.fn(input);
  }
}

describe("evaluateExpectations", () => {
  const base = { expectedOutputContains: [] as string[], expectedOutputNotContains: [] as string[] };

  it("passes when no expectations", () => {
    expect(evaluateExpectations(base, "anything", [])).toBeNull();
  });

  it("fails when output is missing a required substring", () => {
    const r = evaluateExpectations({ ...base, expectedOutputContains: ["foo", "bar"] }, "foo only", []);
    expect(r).toMatch(/expected_output_contains missing/);
    expect(r).toMatch(/bar/);
  });

  it("passes when all required substrings present", () => {
    expect(evaluateExpectations({ ...base, expectedOutputContains: ["a", "b"] }, "a-b", [])).toBeNull();
  });

  it("fails when forbidden substring is present", () => {
    const r = evaluateExpectations({ ...base, expectedOutputNotContains: ["error", "panic"] }, "fatal: panic", []);
    expect(r).toMatch(/expected_output_not_contains present/);
    expect(r).toMatch(/panic/);
  });

  it("passes when no forbidden substrings appear", () => {
    expect(evaluateExpectations({ ...base, expectedOutputNotContains: ["error"] }, "ok", [])).toBeNull();
  });
});

describe("EvalRunner.runForSlug", () => {
  let db: DrizzleDB;
  let skillRepo: SkillRepository;
  let evalRepo: SkillEvalRepository;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite, { schema });
    createTestTables(db);
    skillRepo = new SkillRepository(db);
    evalRepo = new SkillEvalRepository(db);
  });

  async function makeSkill(slug: string): Promise<string> {
    const s = await skillRepo.create({
      slug,
      name: slug,
      description: "x",
      storagePath: `skills/${slug}/`,
      status: "published",
    });
    return s.id;
  }

  it("throws SkillNotFoundError for unknown slug", async () => {
    const runner = new EvalRunner(skillRepo, evalRepo, new EchoEvalProvider());
    await expect(runner.runForSlug("missing")).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("returns empty summary when there are no cases", async () => {
    await makeSkill("s");
    const runner = new EvalRunner(skillRepo, evalRepo, new EchoEvalProvider());
    const sum = await runner.runForSlug("s");
    expect(sum.totalCases).toBe(0);
    expect(sum.cases).toHaveLength(0);
    expect(sum.passed).toBe(0);
    expect(sum.failed).toBe(0);
    expect(sum.errored).toBe(0);
  });

  it("EchoEvalProvider passes a contains-input case and persists a pass row", async () => {
    const id = await makeSkill("s");
    evalRepo.replaceAllForSkill(id, [
      { name: "echo-pass", input: "hello world", expectedOutputContains: ["hello"] },
    ]);
    const runner = new EvalRunner(skillRepo, evalRepo, new EchoEvalProvider());
    const sum = await runner.runForSlug("s");
    expect(sum.totalCases).toBe(1);
    expect(sum.passed).toBe(1);
    expect(sum.failed).toBe(0);
    expect(sum.errored).toBe(0);
    expect(sum.cases[0].status).toBe("pass");
    expect(sum.cases[0].failureReason).toBeNull();
    const persisted = evalRepo.findRunsBySkillVersion(id, sum.version);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].status).toBe("pass");
    expect(persisted[0].runner).toBe("echo");
    expect(persisted[0].output).toBe("hello world");
  });

  it("provider throw → status=error, failureReason set, other cases continue", async () => {
    const id = await makeSkill("s");
    evalRepo.replaceAllForSkill(id, [
      { name: "blows-up", input: "x" },
      { name: "ok", input: "y", expectedOutputContains: ["y"] },
    ]);
    const provider = new StubProvider((input) => {
      if (input.input === "x") throw new Error("boom");
      return { output: input.input, toolsUsed: [] };
    });
    const runner = new EvalRunner(skillRepo, evalRepo, provider);
    const sum = await runner.runForSlug("s");
    expect(sum.totalCases).toBe(2);
    expect(sum.errored).toBe(1);
    expect(sum.passed).toBe(1);
    expect(sum.failed).toBe(0);
    const errored = sum.cases.find((c) => c.caseName === "blows-up")!;
    expect(errored.status).toBe("error");
    expect(errored.failureReason).toBe("boom");
    const rows = evalRepo.findRunsBySkillVersion(id, sum.version);
    expect(rows).toHaveLength(2);
    const errRow = rows.find((r) => r.caseName === "blows-up")!;
    expect(errRow.status).toBe("error");
    expect(errRow.failureReason).toBe("boom");
  });

  it("persists toolsUsed when provider reports them", async () => {
    const id = await makeSkill("s");
    evalRepo.replaceAllForSkill(id, [
      { name: "with-tools", input: "go" },
    ]);
    const provider = new StubProvider(() => ({ output: "done", toolsUsed: ["alpha", "beta"] }));
    const runner = new EvalRunner(skillRepo, evalRepo, provider);
    const sum = await runner.runForSlug("s");
    expect(sum.passed).toBe(1);
    const rows = evalRepo.findRunsBySkillVersion(id, sum.version);
    expect(rows[0].toolsUsed).toEqual(["alpha", "beta"]);
  });

  it("records latencyMs as a non-negative number", async () => {
    const id = await makeSkill("s");
    evalRepo.replaceAllForSkill(id, [
      { name: "c", input: "x", expectedOutputContains: ["x"] },
    ]);
    const runner = new EvalRunner(skillRepo, evalRepo, new EchoEvalProvider());
    const sum = await runner.runForSlug("s");
    expect(sum.cases[0].latencyMs).toBeGreaterThanOrEqual(0);
    const rows = evalRepo.findRunsBySkillVersion(id, sum.version);
    expect(rows[0].latencyMs).toBeGreaterThanOrEqual(0);
  });
});
