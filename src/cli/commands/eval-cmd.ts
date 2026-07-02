import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, type DrizzleDB } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { SkillEvalRepository } from "../../db/repositories/skill-eval.repository.js";
import { EchoEvalProvider } from "../../eval/echo-provider.js";
import { LLMEvalProvider } from "../../eval/llm-eval-provider.js";
import { EvalRunner } from "../../eval/runner.js";
import type { EvalProvider } from "../../eval/provider.interface.js";
import { LocalFileSystemProvider } from "../../storage/local-fs.provider.js";
import { c, fail, kv, fmtDate, table, section, warn } from "../ui.js";
import { SkillNotFoundError } from "../../utils/errors.js";
import { requireAuth } from "./auth-cmd.js";
import { getServerUrl, apiCall } from "../remote-client.js";

interface EvalCase { caseName: string; input?: string; expectedOutputContains: string[]; }
interface EvalRunResult { caseName: string; status: string; }
interface EvalSummary { slug: string; version: string; totalCases: number; passed: number; failed: number; errored: number; cases: EvalRunResult[]; }
interface EvalHistoryRow { skillVersion: string; caseName: string; status: string; createdAt: number; }

export async function evalListAction(slug: string, opts: { serverUrl?: string } = {}): Promise<void> {
  warn("The eval command is experimental and may change without notice.");
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const creds = requireAuth();
    const cases = await apiCall<EvalCase[]>(
      serverUrl, "GET", `/api/admin/skills/${slug}/eval/cases`, { credentials: creds },
    );
    console.log(section("Eval cases", cases.length));
    if (!cases.length) { warn("No eval cases declared."); return; }
    for (const ec of cases) {
      console.log(kv("case", c.bold(ec.caseName)));
      if (ec.input) console.log(kv("input", c.dim(ec.input)));
      if (ec.expectedOutputContains?.length) console.log(kv("contains", ec.expectedOutputContains.join(", ")));
      console.log();
    }
    return;
  }

  // Local mode
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
    if (ec.expectedOutputContains.length) console.log(kv("contains", ec.expectedOutputContains.join(", ")));
    console.log();
  }
}

export async function evalRunAction(slug: string, opts: { serverUrl?: string } = {}): Promise<void> {
  warn("The eval command is experimental and may change without notice.");
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const creds = requireAuth();
    const summary = await apiCall<EvalSummary>(
      serverUrl, "POST", `/api/admin/skills/${slug}/eval/run`, { credentials: creds },
    );
    renderEvalSummary(summary);
    return;
  }

  // Local mode
  const config = getConfig();
  const { skillRepo, evalRepo } = await bootstrap();

  // Resolve provider from config
  let provider: EvalProvider;
  if (config.eval.provider === "llm") {
    provider = new LLMEvalProvider();
  } else {
    provider = new EchoEvalProvider();
  }

  // Read SKILL.md content for LLM provider
  let skillEntry: string | undefined;
  if (config.eval.provider === "llm") {
    const skill = await skillRepo.findBySlug(slug);
    if (skill && config.storage.type === "local-fs") {
      const storage = new LocalFileSystemProvider(config.storage.basePath);
      const entryPath = `${skill.storagePath}${skill.entryFile}`;
      try {
        const buffer = await storage.get(entryPath);
        if (buffer) skillEntry = buffer.toString("utf-8");
      } catch {
        // skill entry not readable — provider will fall back to generic prompt
      }
    }
  }

  const runner = new EvalRunner(skillRepo, evalRepo, provider, undefined, {
    timeoutMs: config.eval.timeout,
    retries: config.eval.retries,
    skillEntry,
  });

  let summary: EvalSummary;
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

  renderEvalSummary(summary);
}

function renderEvalSummary(summary: EvalSummary): void {
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

export async function evalResultsAction(slug: string, options: { limit?: number; serverUrl?: string } = {}): Promise<void> {
  warn("The eval command is experimental and may change without notice.");
  const serverUrl = getServerUrl(options);

  if (serverUrl) {
    const creds = requireAuth();
    const runs = await apiCall<EvalHistoryRow[]>(
      serverUrl, "GET",
      `/api/admin/skills/${slug}/eval/results?limit=${options.limit ?? 20}`,
      { credentials: creds },
    );
    if (!runs.length) { warn("No eval runs found."); return; }
    renderEvalResults(slug, runs);
    return;
  }

  // Local mode
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

function renderEvalResults(slug: string, runs: EvalHistoryRow[]): void {
  console.log(section(`Eval results  ${slug}`, runs.length));
  const rows = runs.map(r => ({
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

async function bootstrap(): Promise<{ db: DrizzleDB; skillRepo: SkillRepository; evalRepo: SkillEvalRepository }> {
  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  return {
    db,
    skillRepo: new SkillRepository(db),
    evalRepo: new SkillEvalRepository(db),
  };
}
