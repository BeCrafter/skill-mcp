import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { SkillEvalRepository } from "../../../src/db/repositories/skill-eval.repository.js";
import { SkillRepository } from "../../../src/db/repositories/skill.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

/**
 * P1-12 stage 2 — SkillEvalRepository contract pins:
 *   - replaceAllForSkill replaces the full case set atomically (re-import
 *     drops removed cases, updates kept cases, inserts new cases).
 *   - findCasesBySkillId / findCaseByName decode the JSON envelope back into
 *     typed string[] arrays (with empty defaults for missing keys).
 *   - appendRun produces an audit-grade row; subsequent
 *     findRunsBySkillVersion returns DESC by createdAt.
 *   - findLatestRunStatusByCase returns one entry per case with the most
 *     recent status (the input the stage-3 regression gate consumes).
 *   - ON DELETE CASCADE: removing the parent skill removes its eval cases
 *     AND its eval runs.
 */

function createTestTables(db: DrizzleDB): void {
  const statements = [
    `CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
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
      tenant_id TEXT NOT NULL DEFAULT 'default',
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
      tenant_id TEXT NOT NULL DEFAULT 'default',
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
    `CREATE INDEX IF NOT EXISTS idx_skill_eval_runs_skill_version ON skill_eval_runs(skill_id, skill_version)`,
  ];
  for (const sql of statements) {
    db.run(sql);
  }
}

describe("SkillEvalRepository", () => {
  let db: DrizzleDB;
  let repo: SkillEvalRepository;
  let skillRepo: SkillRepository;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite, { schema });
    createTestTables(db);
    repo = new SkillEvalRepository(db);
    skillRepo = new SkillRepository(db);
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

  describe("replaceAllForSkill", () => {
    it("inserts cases with full expectations envelope", async () => {
      const id = await makeSkill("ripgrep");
      repo.replaceAllForSkill(id, [
        {
          name: "basic",
          input: "find foo",
          expectedTools: ["search"],
          expectedOutputContains: ["matched"],
          expectedOutputNotContains: ["error"],
        },
      ]);
      const cases = repo.findCasesBySkillId(id);
      expect(cases).toHaveLength(1);
      expect(cases[0].caseName).toBe("basic");
      expect(cases[0].input).toBe("find foo");
      expect(cases[0].expectedTools).toEqual(["search"]);
      expect(cases[0].expectedOutputContains).toEqual(["matched"]);
      expect(cases[0].expectedOutputNotContains).toEqual(["error"]);
    });

    it("normalizes empty arrays to absent (round-trips as []) ", async () => {
      const id = await makeSkill("ripgrep");
      repo.replaceAllForSkill(id, [
        { name: "tools-only", input: "x", expectedTools: ["search"] },
      ]);
      const cases = repo.findCasesBySkillId(id);
      expect(cases[0].expectedTools).toEqual(["search"]);
      expect(cases[0].expectedOutputContains).toEqual([]);
      expect(cases[0].expectedOutputNotContains).toEqual([]);
    });

    it("replaces the full set on re-call (drops removed cases)", async () => {
      const id = await makeSkill("ripgrep");
      repo.replaceAllForSkill(id, [
        { name: "a", input: "in-a", expectedTools: ["x"] },
        { name: "b", input: "in-b", expectedTools: ["y"] },
      ]);
      expect(repo.findCasesBySkillId(id)).toHaveLength(2);

      repo.replaceAllForSkill(id, [
        { name: "a", input: "in-a-v2", expectedTools: ["z"] },
      ]);
      const cases = repo.findCasesBySkillId(id);
      expect(cases).toHaveLength(1);
      expect(cases[0].caseName).toBe("a");
      expect(cases[0].input).toBe("in-a-v2");
      expect(cases[0].expectedTools).toEqual(["z"]);
    });

    it("empty input clears all cases", async () => {
      const id = await makeSkill("ripgrep");
      repo.replaceAllForSkill(id, [{ name: "a", input: "x", expectedTools: ["y"] }]);
      repo.replaceAllForSkill(id, []);
      expect(repo.findCasesBySkillId(id)).toHaveLength(0);
    });

    it("scopes to the given skill (other skills untouched)", async () => {
      const a = await makeSkill("a");
      const b = await makeSkill("b");
      repo.replaceAllForSkill(a, [{ name: "ca", input: "in", expectedTools: ["t"] }]);
      repo.replaceAllForSkill(b, [{ name: "cb", input: "in", expectedTools: ["t"] }]);
      repo.replaceAllForSkill(a, []);
      expect(repo.findCasesBySkillId(a)).toHaveLength(0);
      expect(repo.findCasesBySkillId(b)).toHaveLength(1);
    });
  });

  describe("findCaseByName", () => {
    it("returns the case by name", async () => {
      const id = await makeSkill("s");
      repo.replaceAllForSkill(id, [{ name: "the-case", input: "i", expectedTools: ["t"] }]);
      const got = repo.findCaseByName(id, "the-case");
      expect(got).not.toBeNull();
      expect(got!.caseName).toBe("the-case");
    });

    it("returns null for unknown case name", async () => {
      const id = await makeSkill("s");
      expect(repo.findCaseByName(id, "missing")).toBeNull();
    });
  });

  describe("countCasesBySkillId", () => {
    it("returns 0 when none persisted", async () => {
      const id = await makeSkill("s");
      expect(repo.countCasesBySkillId(id)).toBe(0);
    });

    it("counts replaced rows correctly", async () => {
      const id = await makeSkill("s");
      repo.replaceAllForSkill(id, [
        { name: "a", input: "i", expectedTools: ["t"] },
        { name: "b", input: "i", expectedTools: ["t"] },
        { name: "c", input: "i", expectedTools: ["t"] },
      ]);
      expect(repo.countCasesBySkillId(id)).toBe(3);
    });
  });

  describe("appendRun + findRunsBySkillVersion", () => {
    it("appends rows and reads them DESC by createdAt", async () => {
      const id = await makeSkill("s");
      await repo.appendRun({ skillId: id, skillVersion: "1.0.0", caseName: "c1", status: "pass", runner: "echo" });
      await new Promise((r) => setTimeout(r, 5));
      await repo.appendRun({ skillId: id, skillVersion: "1.0.0", caseName: "c2", status: "fail", runner: "echo", failureReason: "x" });
      const runs = repo.findRunsBySkillVersion(id, "1.0.0");
      expect(runs).toHaveLength(2);
      // DESC: latest first; c2 was last appended → first row.
      expect(runs[0].caseName).toBe("c2");
      expect(runs[0].failureReason).toBe("x");
    });

    it("filters by skillVersion", async () => {
      const id = await makeSkill("s");
      await repo.appendRun({ skillId: id, skillVersion: "1.0.0", caseName: "c1", status: "pass", runner: "echo" });
      await repo.appendRun({ skillId: id, skillVersion: "1.1.0", caseName: "c1", status: "fail", runner: "echo" });
      expect(repo.findRunsBySkillVersion(id, "1.0.0")).toHaveLength(1);
      expect(repo.findRunsBySkillVersion(id, "1.1.0")).toHaveLength(1);
      expect(repo.findRunsBySkillVersion(id, "9.9.9")).toHaveLength(0);
    });

    it("preserves toolsUsed JSON round-trip", async () => {
      const id = await makeSkill("s");
      await repo.appendRun({
        skillId: id, skillVersion: "1.0.0", caseName: "c", status: "pass", runner: "echo",
        toolsUsed: ["alpha", "beta"], output: "out", latencyMs: 42,
      });
      const runs = repo.findRunsBySkillVersion(id, "1.0.0");
      expect(runs[0].toolsUsed).toEqual(["alpha", "beta"]);
      expect(runs[0].output).toBe("out");
      expect(runs[0].latencyMs).toBe(42);
    });

    it("toolsUsed defaults to [] when not provided", async () => {
      const id = await makeSkill("s");
      await repo.appendRun({ skillId: id, skillVersion: "1.0.0", caseName: "c", status: "pass", runner: "echo" });
      const runs = repo.findRunsBySkillVersion(id, "1.0.0");
      expect(runs[0].toolsUsed).toEqual([]);
    });
  });

  describe("findLatestRunStatusByCase (stage 3 input)", () => {
    it("returns the latest status per case_name", async () => {
      const id = await makeSkill("s");
      await repo.appendRun({ skillId: id, skillVersion: "1.0.0", caseName: "c1", status: "fail", runner: "echo" });
      // small delay so createdAt diverges
      await new Promise((r) => setTimeout(r, 5));
      await repo.appendRun({ skillId: id, skillVersion: "1.0.0", caseName: "c1", status: "pass", runner: "echo" });
      await repo.appendRun({ skillId: id, skillVersion: "1.0.0", caseName: "c2", status: "error", runner: "echo" });
      const map = repo.findLatestRunStatusByCase(id, "1.0.0");
      expect(map.size).toBe(2);
      expect(map.get("c1")).toBe("pass");
      expect(map.get("c2")).toBe("error");
    });

    it("returns empty when no runs for the version", async () => {
      const id = await makeSkill("s");
      const map = repo.findLatestRunStatusByCase(id, "1.0.0");
      expect(map.size).toBe(0);
    });
  });

  describe("findRecentRuns", () => {
    it("limits and orders DESC", async () => {
      const id = await makeSkill("s");
      for (let i = 0; i < 5; i++) {
        await repo.appendRun({ skillId: id, skillVersion: "1.0.0", caseName: `c${i}`, status: "pass", runner: "echo" });
        await new Promise((r) => setTimeout(r, 2));
      }
      const runs = repo.findRecentRuns(id, 3);
      expect(runs).toHaveLength(3);
      expect(runs[0].caseName).toBe("c4");
    });
  });

  describe("ON DELETE CASCADE", () => {
    it("removes cases AND runs when skill is deleted", async () => {
      const id = await makeSkill("s");
      repo.replaceAllForSkill(id, [{ name: "c", input: "i", expectedTools: ["t"] }]);
      await repo.appendRun({ skillId: id, skillVersion: "1.0.0", caseName: "c", status: "pass", runner: "echo" });
      expect(repo.countCasesBySkillId(id)).toBe(1);
      expect(repo.findRecentRuns(id, 10)).toHaveLength(1);

      await skillRepo.delete("s");

      expect(repo.countCasesBySkillId(id)).toBe(0);
      expect(repo.findRecentRuns(id, 10)).toHaveLength(0);
    });
  });
});
