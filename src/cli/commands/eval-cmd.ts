import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { SkillEvalRepository } from "../../db/repositories/skill-eval.repository.js";
import { EchoEvalProvider } from "../../eval/echo-provider.js";
import { EvalRunner } from "../../eval/runner.js";
import { c, fail, ok, detail, fmtDate } from "../ui.js";
import { SkillNotFoundError } from "../../utils/errors.js";

/**
 * P1-12 stage 2 — `skill-mcp eval list <slug>` — print every persisted case
 * with its expectations. Useful as a smoke-test that import wired through.
 */
export async function evalListAction(slug: string): Promise<void> {
  const { skillRepo, evalRepo } = await bootstrap();
  const skill = await skillRepo.findBySlug(slug);
  if (!skill) {
    fail(`Skill not found: ${slug}`);
    process.exit(1);
  }
  const cases = evalRepo.findCasesBySkillId(skill.id);
  console.log(`\n  ${c.bold("Eval cases for")} ${c.boldCyan(slug)}  ${c.dim("v" + skill.version)}\n`);
  if (cases.length === 0) {
    console.log(`  ${c.dim("(no cases — add `eval_cases:` to SKILL.md and re-import)")}\n`);
    return;
  }
  for (const ec of cases) {
    console.log(`  ${c.bold(ec.caseName)}`);
    console.log(detail("input", JSON.stringify(ec.input)));
    if (ec.expectedTools.length > 0) console.log(detail("tools", ec.expectedTools.join(", ")));
    if (ec.expectedOutputContains.length > 0) console.log(detail("contains", JSON.stringify(ec.expectedOutputContains)));
    if (ec.expectedOutputNotContains.length > 0) console.log(detail("!contains", JSON.stringify(ec.expectedOutputNotContains)));
    console.log();
  }
}

/**
 * P1-12 stage 2 — `skill-mcp eval run <slug>` — execute every case through
 * the stub echo provider, persist a row per case to skill_eval_runs, and
 * print a colored pass/fail/error breakdown. Stage 3 swaps the provider for
 * a real LLM via `--provider <name>`.
 *
 * Exit code is 0 unless any case failed or errored — letting CI gate
 * merges on `skill-mcp eval run <slug> && ...`.
 */
export async function evalRunAction(slug: string): Promise<void> {
  const { skillRepo, evalRepo } = await bootstrap();
  const provider = new EchoEvalProvider();
  const runner = new EvalRunner(skillRepo, evalRepo, provider);

  let summary;
  try {
    summary = await runner.runForSlug(slug);
  } catch (err) {
    if (err instanceof SkillNotFoundError) {
      fail(`Skill not found: ${slug}`);
    } else {
      fail(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  }

  console.log(`\n  ${c.bold("Eval run")} ${c.boldCyan(summary.slug)}  ${c.dim("v" + summary.version)}  ${c.dim("·")}  ${c.dim("runner=" + summary.runner)}\n`);
  if (summary.totalCases === 0) {
    console.log(`  ${c.dim("(no cases to run — add `eval_cases:` to SKILL.md and re-import)")}\n`);
    return;
  }

  for (const ec of summary.cases) {
    const marker =
      ec.status === "pass" ? c.boldGreen("✓") :
      ec.status === "fail" ? c.boldRed("✗") :
      c.yellow("!");
    const lat = c.dim(`${ec.latencyMs}ms`);
    console.log(`  ${marker}  ${c.bold(ec.caseName)}  ${lat}`);
    if (ec.failureReason) console.log(`        ${c.dim(ec.failureReason)}`);
  }

  const tally = `${c.boldGreen(summary.passed + " pass")}  ${summary.failed > 0 ? c.boldRed(summary.failed + " fail") : c.dim(summary.failed + " fail")}  ${summary.errored > 0 ? c.yellow(summary.errored + " error") : c.dim(summary.errored + " error")}`;
  console.log(`\n  ${c.bold("Result:")}  ${tally}  ${c.dim("of " + summary.totalCases)}\n`);
  if (summary.failed > 0 || summary.errored > 0) process.exit(1);
}

/**
 * P1-12 stage 2 — `skill-mcp eval results <slug>` — print the most recent
 * runs for the skill (latest 20). Mirrors the `versions` command's history
 * view; stage 3's regression gate uses the same data through the repo.
 */
export async function evalResultsAction(slug: string, options: { limit?: number }): Promise<void> {
  const { skillRepo, evalRepo } = await bootstrap();
  const skill = await skillRepo.findBySlug(slug);
  if (!skill) {
    fail(`Skill not found: ${slug}`);
    process.exit(1);
  }
  const limit = options.limit ?? 20;
  const runs = evalRepo.findRecentRuns(skill.id, limit);
  console.log(`\n  ${c.bold("Recent eval runs for")} ${c.boldCyan(slug)}  ${c.dim("(latest " + limit + ")")}\n`);
  if (runs.length === 0) {
    console.log(`  ${c.dim("(no runs yet — invoke `skill-mcp eval run " + slug + "`)")}\n`);
    return;
  }
  for (const r of runs) {
    const marker =
      r.status === "pass" ? c.boldGreen("✓") :
      r.status === "fail" ? c.boldRed("✗") :
      c.yellow("!");
    const lat = r.latencyMs !== null ? c.dim(`${r.latencyMs}ms`) : "";
    console.log(`  ${marker}  ${c.dim(fmtDate(r.createdAt))}  ${c.bold(r.caseName)}  ${c.dim("v" + r.skillVersion)}  ${lat}`);
    if (r.failureReason) console.log(`        ${c.dim(r.failureReason)}`);
  }
  ok(`${runs.length} run(s) shown`);
}

async function bootstrap(): Promise<{ skillRepo: SkillRepository; evalRepo: SkillEvalRepository }> {
  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  return {
    skillRepo: new SkillRepository(db),
    evalRepo: new SkillEvalRepository(db),
  };
}
