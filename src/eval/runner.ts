import type { Logger } from "pino";
import type { SkillRepository } from "../db/repositories/skill.repository.js";
import type { SkillEvalRepository, SkillEvalCaseRow, EvalRunStatus } from "../db/repositories/skill-eval.repository.js";
import type { EvalProvider } from "./provider.interface.js";
import { SkillNotFoundError } from "../utils/errors.js";

/**
 * P1-12 stage 2 — Eval runner. Loads every persisted case for a skill, runs
 * each one through the configured provider, evaluates expectations, and
 * appends one `skill_eval_runs` row per case. Returns a summary the CLI / a
 * future REST endpoint can present.
 *
 * Failure semantics:
 *   - Provider throws → row gets `status="error"` with `failureReason`. The
 *     run continues to the next case so a single bad case doesn't mask the
 *     others.
 *   - At least one expectation fails → row gets `status="fail"` with the
 *     first failure surfaced as `failureReason`.
 *   - All expectations pass → row gets `status="pass"`.
 *
 * Stage 3 will reuse this runner inside the version-bump regression gate by
 * comparing the latest-run map between two versions.
 */

export interface CaseEvaluation {
  caseName: string;
  status: EvalRunStatus;
  output: string | null;
  toolsUsed: string[];
  failureReason: string | null;
  latencyMs: number;
}

export interface RunSummary {
  skillId: string;
  slug: string;
  version: string;
  runner: string;
  totalCases: number;
  passed: number;
  failed: number;
  errored: number;
  cases: CaseEvaluation[];
}

export class EvalRunner {
  constructor(
    private skillRepo: SkillRepository,
    private evalRepo: SkillEvalRepository,
    private provider: EvalProvider,
    private logger?: Logger,
  ) {}

  async runForSlug(slug: string): Promise<RunSummary> {
    const skill = await this.skillRepo.findBySlug(slug);
    if (!skill) throw new SkillNotFoundError(slug);
    const cases = this.evalRepo.findCasesBySkillId(skill.id);

    const summary: RunSummary = {
      skillId: skill.id,
      slug: skill.slug,
      version: skill.version,
      runner: this.provider.name,
      totalCases: cases.length,
      passed: 0,
      failed: 0,
      errored: 0,
      cases: [],
    };

    for (const c of cases) {
      const evaluation = await this.runCase(skill.slug, skill.id, skill.version, c);
      summary.cases.push(evaluation);
      if (evaluation.status === "pass") summary.passed += 1;
      else if (evaluation.status === "fail") summary.failed += 1;
      else summary.errored += 1;
    }

    return summary;
  }

  private async runCase(
    skillSlug: string,
    skillId: string,
    skillVersion: string,
    c: SkillEvalCaseRow,
  ): Promise<CaseEvaluation> {
    const start = Date.now();
    let output: string | null = null;
    let toolsUsed: string[] = [];
    let status: EvalRunStatus;
    let failureReason: string | null = null;

    try {
      const result = await this.provider.run(c.input, { skillSlug, caseName: c.caseName });
      output = result.output;
      toolsUsed = result.toolsUsed;
      const failure = evaluateExpectations(c, result.output, result.toolsUsed);
      if (failure) {
        status = "fail";
        failureReason = failure;
      } else {
        status = "pass";
      }
    } catch (err) {
      status = "error";
      failureReason = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ err, slug: skillSlug, caseName: c.caseName }, "Eval provider threw");
    }

    const latencyMs = Date.now() - start;
    this.evalRepo.appendRun({
      skillId,
      skillVersion,
      caseName: c.caseName,
      status,
      runner: this.provider.name,
      toolsUsed,
      output,
      failureReason,
      latencyMs,
    });

    return { caseName: c.caseName, status, output, toolsUsed, failureReason, latencyMs };
  }
}

/**
 * Returns null on pass; the first failure message otherwise. Order matters
 * only for the message the user sees — the case is `fail` if any one of the
 * three checks fails.
 */
export function evaluateExpectations(
  c: Pick<SkillEvalCaseRow, "expectedTools" | "expectedOutputContains" | "expectedOutputNotContains">,
  output: string,
  toolsUsed: string[],
): string | null {
  if (c.expectedTools.length > 0) {
    const seen = new Set(toolsUsed);
    const missing = c.expectedTools.filter((t) => !seen.has(t));
    if (missing.length > 0) {
      return `expected_tools missing: ${missing.join(", ")}`;
    }
  }
  if (c.expectedOutputContains.length > 0) {
    const missing = c.expectedOutputContains.filter((s) => !output.includes(s));
    if (missing.length > 0) {
      return `expected_output_contains missing: ${JSON.stringify(missing)}`;
    }
  }
  if (c.expectedOutputNotContains.length > 0) {
    const present = c.expectedOutputNotContains.filter((s) => output.includes(s));
    if (present.length > 0) {
      return `expected_output_not_contains present: ${JSON.stringify(present)}`;
    }
  }
  return null;
}
