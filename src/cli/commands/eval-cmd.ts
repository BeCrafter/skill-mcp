import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { SkillEvalRepository } from "../../db/repositories/skill-eval.repository.js";
import { EchoEvalProvider } from "../../eval/echo-provider.js";
import { EvalRunner } from "../../eval/runner.js";
import { c, fail, kv, fmtDate, table, section, warn } from "../ui.js";
import { SkillNotFoundError } from "../../utils/errors.js";

/**
 * P1-12 stage 2 — `skill-mcp eval list <slug>` — print every persisted case
 * with its expectations. Useful as a smoke-test that import wired through.
 */
export async function evalListAction(slug: string): Promise<void> {
  const { skillRepo, evalRepo } = await bootstrap();
  const skill = await skillRepo.findBySlug(slug);
  if (!skill) {
    fail(`Skill not found: ${slug}`, "Use `skill-mcp list` to see available skills");
    process.exit(1);
  }
  const cases = evalRepo.findCasesBySkillId(skill.id);

  console.log(section("Eval cases", cases.length));

  if (cases.length === 0) {
    warn("No eval cases declared.");
    return;
  }

  for (const ec of cases) {
    console.log(kv("case", c.bold(ec.caseName)));
    if (ec.input) console.log(kv("input", c.dim(ec.input)));
    if (ec.expectedTools.length) console.log(kv("tools", ec.expectedTools.join(", ")));
    if (ec.expectedOutputContains.length) console.log(kv("contains", ec.expectedOutputContains.join(", ")));
    console.log();
  }
}

/**
 * P1-12 stage 2 — `skill-mcp eval run <slug>` — execute every case through
 * the stub echo provider, persist a row per case to skill_eval_runs, and
 * print a colored pass/fail/error breakdown.
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
      fail(`Skill not found: ${slug}`, "Use `skill-mcp list` to see available skills");
    } else {
      fail((err as Error).message);
    }
    process.exit(1);
  }

  console.log(section(`Eval run  ${summary.slug}  v${summary.version}`));
  console.log();

  if (summary.totalCases === 0) {
    warn("No eval cases declared.");
    return;
  }

  const rows = summary.cases.map(ec => ({
    caseName: ec.caseName,
    status: ec.status === "pass"
      ? c.boldGreen("pass")
      : ec.status === "fail"
        ? c.boldRed("fail")
        : c.boldYellow("error"),
  }));

  console.log(table(rows, [
    { key: "caseName", header: "CASE", width: 20 },
    { key: "status", header: "STATUS", width: 10 },
  ]));

  const tally = `${c.boldGreen(summary.passed + " pass")}  ${summary.failed > 0 ? c.boldRed(summary.failed + " fail") : c.dim(summary.failed + " fail")}  ${summary.errored > 0 ? c.yellow(summary.errored + " error") : c.dim(summary.errored + " error")}`;
  console.log(`\n  Result:  ${tally}  ${c.dim("of " + summary.totalCases)}\n`);
  if (summary.failed > 0 || summary.errored > 0) process.exit(1);
}

/**
 * P1-12 stage 2 — `skill-mcp eval results <slug>` — print the most recent
 * runs for the skill (latest 20).
 */
export async function evalResultsAction(slug: string, options: { limit?: number }): Promise<void> {
  const { skillRepo, evalRepo } = await bootstrap();
  const skill = await skillRepo.findBySlug(slug);
  if (!skill) {
    fail(`Skill not found: ${slug}`, "Use `skill-mcp list` to see available skills");
    process.exit(1);
  }

  const runs = evalRepo.findRunsBySkillVersion(skill.id, skill.version);

  console.log(section(`Eval results  ${slug}`, runs.length));

  if (runs.length === 0) {
    warn("No eval runs found.");
    return;
  }

  const limited = options.limit ? runs.slice(-options.limit) : runs;

  const rows = limited.map(r => ({
    version: r.skillVersion,
    caseName: r.caseName,
    status: r.status === "pass" ? c.boldGreen("pass") : r.status === "fail" ? c.boldRed("fail") : c.boldYellow("error"),
    created: fmtDate(r.createdAt),
  }));

  console.log(table(rows, [
    { key: "version", header: "VERSION", width: 10 },
    { key: "caseName", header: "CASE", width: 20 },
    { key: "status", header: "STATUS", width: 10 },
    { key: "created", header: "CREATED", width: 18 },
  ]));

  console.log();
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
