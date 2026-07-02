import type { Logger } from "pino";
import type { SkillRepository } from "../db/repositories/skill.repository.js";
import type { SkillEvalRepository, SkillEvalCaseRow, EvalRunStatus } from "../db/repositories/skill-eval.repository.js";
import type { EvalProvider, EvalInput } from "./provider.interface.js";
import { SkillNotFoundError } from "../utils/errors.js";

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

export interface EvalRunnerOptions {
  timeoutMs?: number;
  retries?: number;
  /** SKILL.md content passed to the eval provider as system prompt. */
  skillEntry?: string;
}

export class EvalRunner {
  constructor(
    private skillRepo: SkillRepository,
    private evalRepo: SkillEvalRepository,
    private provider: EvalProvider,
    private logger?: Logger,
    private options: EvalRunnerOptions = {},
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
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const maxAttempts = 1 + (this.options.retries ?? 1);

    const evalInput: EvalInput = { input: c.input, skillEntry: this.options.skillEntry };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.withTimeout(
          this.provider.run(evalInput, { skillSlug, caseName: c.caseName }),
          timeoutMs,
        );
        output = result.output;
        toolsUsed = result.toolsUsed;
        const failure = evaluateExpectations(c, result.output, result.toolsUsed);
        if (failure) {
          status = "fail";
          failureReason = failure;
        } else {
          status = "pass";
        }
        break;
      } catch (err) {
        if (attempt < maxAttempts - 1) {
          this.logger?.warn({ err, slug: skillSlug, caseName: c.caseName, attempt }, "Eval attempt failed, retrying");
          continue;
        }
        status = "error";
        failureReason = err instanceof Error ? err.message : String(err);
        this.logger?.warn({ err, slug: skillSlug, caseName: c.caseName }, "Eval provider failed after retries");
      }
    }

    const latencyMs = Date.now() - start;
    this.evalRepo.appendRun({
      skillId,
      skillVersion,
      caseName: c.caseName,
      status: status!,
      runner: this.provider.name,
      toolsUsed,
      output,
      failureReason,
      latencyMs,
    });

    return { caseName: c.caseName, status: status!, output, toolsUsed, failureReason, latencyMs };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Eval timed out after ${ms}ms`)), ms)),
    ]);
  }
}

export function evaluateExpectations(
  c: Pick<SkillEvalCaseRow, "expectedOutputContains" | "expectedOutputNotContains">,
  output: string,
  _toolsUsed: string[],
): string | null {
  if (c.expectedOutputContains.length > 0) {
    const missing = c.expectedOutputContains.filter((s) => !output.includes(s));
    if (missing.length > 0) return `expected_output_contains missing: ${JSON.stringify(missing)}`;
  }
  if (c.expectedOutputNotContains.length > 0) {
    const present = c.expectedOutputNotContains.filter((s) => output.includes(s));
    if (present.length > 0) return `expected_output_not_contains present: ${JSON.stringify(present)}`;
  }
  return null;
}
