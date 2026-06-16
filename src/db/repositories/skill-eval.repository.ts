import { generateId, generateUniqueId } from "../../utils/id.js";
import { and, desc, eq } from "drizzle-orm";
import type { DrizzleDB } from "../connection.js";
import { skillEvalCases, skillEvalRuns } from "../schema.js";
import type { SkillEvalCase } from "../../types/index.js";

/**
 * P1-12 stage 2 — Persist & query eval cases + runs. Two responsibilities:
 *
 *   1. **Cases** — the importer hands in the validated stage-1 frontmatter
 *      view; we upsert rows on the (skill_id, case_name) UNIQUE so re-imports
 *      replace rather than duplicate. Cases removed from a re-imported skill
 *      are pruned with `replaceAll`.
 *   2. **Runs** — the runner CLI appends one row per (case × invocation).
 *      Stage 3's regression gate queries `findLatestRunStatus(skillId,
 *      version)` to ask "did every case for this version produce a `pass`
 *      row?".
 */

export interface SkillEvalCaseRow {
  id: string;
  skillId: string;
  caseName: string;
  input: string;
  expectedTools: string[];
  expectedOutputContains: string[];
  expectedOutputNotContains: string[];
  createdAt: number;
  updatedAt: number;
}

export type EvalRunStatus = "pass" | "fail" | "error";

export interface SkillEvalRunRow {
  id: string;
  skillId: string;
  skillVersion: string;
  caseName: string;
  status: EvalRunStatus;
  runner: string;
  toolsUsed: string[];
  output: string | null;
  failureReason: string | null;
  latencyMs: number | null;
  createdAt: number;
}

export interface AppendEvalRunInput {
  skillId: string;
  skillVersion: string;
  caseName: string;
  status: EvalRunStatus;
  runner: string;
  toolsUsed?: string[];
  output?: string | null;
  failureReason?: string | null;
  latencyMs?: number | null;
}

interface ExpectationsEnvelope {
  expectedTools?: string[];
  expectedOutputContains?: string[];
  expectedOutputNotContains?: string[];
}

export class SkillEvalRepository {
  constructor(private db: DrizzleDB) {}

  /**
   * Replace the full set of cases for `skillId` with `cases`. Existing rows
   * not in `cases` are deleted; existing rows by name are updated; new rows
   * are inserted. Stage 1's caps + uniqueness are assumed already enforced —
   * this method does not re-validate, but it does normalize empty arrays
   * back to absent so the envelope stays compact.
   */
  replaceAllForSkill(skillId: string, cases: SkillEvalCase[]): void {
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.delete(skillEvalCases).where(eq(skillEvalCases.skillId, skillId)).run();
      if (cases.length === 0) return;
      for (const c of cases) {
        const envelope: ExpectationsEnvelope = {};
        if (c.expectedTools && c.expectedTools.length > 0) envelope.expectedTools = c.expectedTools;
        if (c.expectedOutputContains && c.expectedOutputContains.length > 0) envelope.expectedOutputContains = c.expectedOutputContains;
        if (c.expectedOutputNotContains && c.expectedOutputNotContains.length > 0) envelope.expectedOutputNotContains = c.expectedOutputNotContains;
        tx.insert(skillEvalCases).values({
          id: generateId("evl_"),
          skillId,
          caseName: c.name,
          input: c.input,
          expectationsJson: JSON.stringify(envelope),
          createdAt: now,
          updatedAt: now,
        }).run();
      }
    });
  }

  findCasesBySkillId(skillId: string): SkillEvalCaseRow[] {
    const rows = this.db
      .select()
      .from(skillEvalCases)
      .where(eq(skillEvalCases.skillId, skillId))
      .all();
    return rows.map((r) => this.toCaseEntity(r));
  }

  findCaseByName(skillId: string, caseName: string): SkillEvalCaseRow | null {
    const row = this.db
      .select()
      .from(skillEvalCases)
      .where(and(eq(skillEvalCases.skillId, skillId), eq(skillEvalCases.caseName, caseName)))
      .get();
    return row ? this.toCaseEntity(row) : null;
  }

  countCasesBySkillId(skillId: string): number {
    return this.db.select().from(skillEvalCases).where(eq(skillEvalCases.skillId, skillId)).all().length;
  }

  async appendRun(input: AppendEvalRunInput): Promise<SkillEvalRunRow> {
    const id = await generateUniqueId(() => generateId("evl_"), async (id) => {
      const row = this.db.select({ id: skillEvalRuns.id }).from(skillEvalRuns).where(eq(skillEvalRuns.id, id)).get();
      return !!row;
    });
    const now = Date.now();
    const toolsJson = input.toolsUsed && input.toolsUsed.length > 0 ? JSON.stringify(input.toolsUsed) : null;
    this.db.insert(skillEvalRuns).values({
      id,
      skillId: input.skillId,
      skillVersion: input.skillVersion,
      caseName: input.caseName,
      status: input.status,
      runner: input.runner,
      toolsUsedJson: toolsJson,
      output: input.output ?? null,
      failureReason: input.failureReason ?? null,
      latencyMs: input.latencyMs ?? null,
      createdAt: now,
    }).run();
    return {
      id,
      skillId: input.skillId,
      skillVersion: input.skillVersion,
      caseName: input.caseName,
      status: input.status,
      runner: input.runner,
      toolsUsed: input.toolsUsed ?? [],
      output: input.output ?? null,
      failureReason: input.failureReason ?? null,
      latencyMs: input.latencyMs ?? null,
      createdAt: now,
    };
  }

  findRunsBySkillVersion(skillId: string, skillVersion: string): SkillEvalRunRow[] {
    const rows = this.db
      .select()
      .from(skillEvalRuns)
      .where(and(eq(skillEvalRuns.skillId, skillId), eq(skillEvalRuns.skillVersion, skillVersion)))
      .orderBy(desc(skillEvalRuns.createdAt))
      .all();
    return rows.map((r) => this.toRunEntity(r));
  }

  findRecentRuns(skillId: string, limit: number): SkillEvalRunRow[] {
    const rows = this.db
      .select()
      .from(skillEvalRuns)
      .where(eq(skillEvalRuns.skillId, skillId))
      .orderBy(desc(skillEvalRuns.createdAt))
      .limit(limit)
      .all();
    return rows.map((r) => this.toRunEntity(r));
  }

  /**
   * Stage 3 entry-point: returns the latest status per case_name for the
   * given (skillId, version). Map keys = case names, values = latest status.
   * Cases that never ran are omitted; the regression gate uses
   * `cases.length === map.size && all values === "pass"`.
   */
  findLatestRunStatusByCase(skillId: string, skillVersion: string): Map<string, EvalRunStatus> {
    const rows = this.findRunsBySkillVersion(skillId, skillVersion);
    const seen = new Map<string, EvalRunStatus>();
    for (const r of rows) {
      if (!seen.has(r.caseName)) seen.set(r.caseName, r.status);
    }
    return seen;
  }

  private toCaseEntity(row: typeof skillEvalCases.$inferSelect): SkillEvalCaseRow {
    const env = parseExpectations(row.expectationsJson);
    return {
      id: row.id,
      skillId: row.skillId,
      caseName: row.caseName,
      input: row.input,
      expectedTools: env.expectedTools ?? [],
      expectedOutputContains: env.expectedOutputContains ?? [],
      expectedOutputNotContains: env.expectedOutputNotContains ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toRunEntity(row: typeof skillEvalRuns.$inferSelect): SkillEvalRunRow {
    let toolsUsed: string[] = [];
    if (row.toolsUsedJson) {
      try {
        const parsed = JSON.parse(row.toolsUsedJson) as unknown;
        if (Array.isArray(parsed)) toolsUsed = parsed.filter((s): s is string => typeof s === "string");
      } catch {
        toolsUsed = [];
      }
    }
    return {
      id: row.id,
      skillId: row.skillId,
      skillVersion: row.skillVersion,
      caseName: row.caseName,
      status: row.status as EvalRunStatus,
      runner: row.runner,
      toolsUsed,
      output: row.output,
      failureReason: row.failureReason,
      latencyMs: row.latencyMs,
      createdAt: row.createdAt,
    };
  }
}

function parseExpectations(raw: string): ExpectationsEnvelope {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const e = parsed as Record<string, unknown>;
    const out: ExpectationsEnvelope = {};
    if (Array.isArray(e.expectedTools)) out.expectedTools = e.expectedTools.filter((s): s is string => typeof s === "string");
    if (Array.isArray(e.expectedOutputContains)) out.expectedOutputContains = e.expectedOutputContains.filter((s): s is string => typeof s === "string");
    if (Array.isArray(e.expectedOutputNotContains)) out.expectedOutputNotContains = e.expectedOutputNotContains.filter((s): s is string => typeof s === "string");
    return out;
  } catch {
    return {};
  }
}
