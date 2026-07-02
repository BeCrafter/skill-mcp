import { describe, it, expect, vi } from "vitest";
import { SkillService } from "@/services/skill.service.js";
import type { ISkillProvider } from "@/provider/interface.js";
import type { ICacheProvider } from "@/cache/provider.interface.js";
import type { SkillRepository } from "@/db/repositories/skill.repository.js";
import type { SkillEvalRepository, SkillEvalCaseRow, EvalRunStatus } from "@/db/repositories/skill-eval.repository.js";
import type { Logger } from "pino";
import type { SkillMeta } from "@/types/index.js";
import { CacheEpochManager } from "@/cache/cache-epochs.js";
import { EvalRegressionError } from "@/utils/errors.js";

/**
 * P1-12 stage 3 — version-bump regression gate. Contract pins:
 *   - target=published + evalRepo wired + cases exist + every case has a
 *     "pass" row for skill.version → transition succeeds.
 *   - any case status !== "pass" → EvalRegressionError lists it under failing.
 *   - any case missing a row for skill.version → listed under untested.
 *   - cases.length === 0 (eval-less skill) → gate is a no-op.
 *   - skipEvalGate: true → gate bypassed (force flag).
 *   - target ∈ {deprecated, archived} → gate never runs.
 *   - evalRepo not wired → gate never runs (legacy callers preserved).
 */

function makeSkill(overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    id: "sk-1",
    slug: "demo",
    name: "demo",
    displayName: null,
    description: "",
    version: "1.2.3",
    category: null,
    tags: [],
    attributes: {},
    status: "draft",
    visibility: "private",
    entryFile: "SKILL.md",
    storagePath: "demo/",
    contentHash: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function silentLogger(): Logger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(), silent: vi.fn(),
  } as unknown as Logger;
}

function makeCase(name: string): SkillEvalCaseRow {
  return {
    id: `case-${name}`,
    skillId: "sk-1",
    caseName: name,
    input: `input-${name}`,
    expectedOutputContains: [],
    expectedOutputNotContains: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function setup(opts: {
  initial?: SkillMeta;
  cases?: SkillEvalCaseRow[];
  latest?: Map<string, EvalRunStatus>;
  withEvalRepo?: boolean;
}) {
  const initial = opts.initial ?? makeSkill();
  const cases = opts.cases ?? [];
  const latest = opts.latest ?? new Map<string, EvalRunStatus>();
  const current = { skill: { ...initial } };

  const skillRepo = {
    findBySlug: vi.fn(async (slug: string) => (slug === current.skill.slug ? current.skill : null)),
    findById: vi.fn(async (id: string) => (id === current.skill.id ? current.skill : null)),
    update: vi.fn(async (id: string, patch: Partial<SkillMeta>) => {
      if (id !== current.skill.id) return null;
      current.skill = { ...current.skill, ...patch };
      return current.skill;
    }),
  } as unknown as SkillRepository;

  const evalRepo = {
    findCasesBySkillId: vi.fn(() => cases),
    findLatestRunStatusByCase: vi.fn(() => latest),
  } as unknown as SkillEvalRepository;

  const provider: ISkillProvider = {
    listSkills: vi.fn(),
    getSkillMeta: vi.fn(async (slug: string) => (slug === current.skill.slug ? current.skill : null)),
    getSkillMetaById: vi.fn(async (id: string) => (id === current.skill.id ? current.skill : null)),
    getSkillEntry: vi.fn(),
    getSkillFiles: vi.fn(),
    getSkillFileTree: vi.fn(),
    skillExists: vi.fn(),
  };

  const cache: ICacheProvider = {
    get: vi.fn().mockResolvedValue(null),
    getWithMeta: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    delete: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    clearByPrefix: vi.fn().mockResolvedValue(undefined),
  };

  const adminDeps = opts.withEvalRepo === false ? undefined : { evalRepo };
  const service = new SkillService(
    provider, cache, silentLogger(),
    undefined, undefined, undefined,
    skillRepo, undefined, new CacheEpochManager(), undefined,
    adminDeps,
  );
  return { service, skillRepo, evalRepo, current };
}

describe("SkillService.transitionLifecycle — P1-12 stage 3 regression gate", () => {
  it("allows publish when no cases are persisted (gate trivially passes)", async () => {
    const { service, skillRepo } = setup({
      initial: makeSkill({ status: "draft" }),
      cases: [],
    });
    const out = await service.transitionLifecycle("demo", "published");
    expect(out.status).toBe("published");
    expect(skillRepo.update).toHaveBeenCalledWith("sk-1", { status: "published" });
  });

  it("allows publish when every case has a pass row for the current version", async () => {
    const cases = [makeCase("a"), makeCase("b")];
    const latest = new Map<string, EvalRunStatus>([["a", "pass"], ["b", "pass"]]);
    const { service, evalRepo } = setup({
      initial: makeSkill({ status: "draft" }),
      cases,
      latest,
    });
    const out = await service.transitionLifecycle("demo", "published");
    expect(out.status).toBe("published");
    expect(evalRepo.findLatestRunStatusByCase).toHaveBeenCalledWith("sk-1", "1.2.3");
  });

  it("blocks publish with EvalRegressionError when a case failed", async () => {
    const cases = [makeCase("a"), makeCase("b")];
    const latest = new Map<string, EvalRunStatus>([["a", "pass"], ["b", "fail"]]);
    const { service } = setup({
      initial: makeSkill({ status: "draft" }),
      cases,
      latest,
    });
    const err = await service.transitionLifecycle("demo", "published").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalRegressionError);
    const e = err as EvalRegressionError;
    expect(e.failingCases).toEqual(["b"]);
    expect(e.untestedCases).toEqual([]);
    expect(e.statusCode).toBe(409);
    expect(e.code).toBe("EVAL_REGRESSION_GATE");
    expect(e.slug).toBe("demo");
    expect(e.version).toBe("1.2.3");
  });

  it("treats a case with no run for the current version as untested", async () => {
    const cases = [makeCase("a"), makeCase("b")];
    const latest = new Map<string, EvalRunStatus>([["a", "pass"]]);
    const { service } = setup({
      initial: makeSkill({ status: "draft" }),
      cases,
      latest,
    });
    const err = await service.transitionLifecycle("demo", "published").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalRegressionError);
    const e = err as EvalRegressionError;
    expect(e.failingCases).toEqual([]);
    expect(e.untestedCases).toEqual(["b"]);
  });

  it("treats `error` status as failing (provider crash → no signal)", async () => {
    const cases = [makeCase("a")];
    const latest = new Map<string, EvalRunStatus>([["a", "error"]]);
    const { service } = setup({
      initial: makeSkill({ status: "draft" }),
      cases,
      latest,
    });
    const err = await service.transitionLifecycle("demo", "published").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalRegressionError);
    expect((err as EvalRegressionError).failingCases).toEqual(["a"]);
  });

  it("`skipEvalGate: true` bypasses the gate even when cases are failing", async () => {
    const cases = [makeCase("a"), makeCase("b")];
    const latest = new Map<string, EvalRunStatus>([["a", "fail"]]);
    const { service, current } = setup({
      initial: makeSkill({ status: "draft" }),
      cases,
      latest,
    });
    const out = await service.transitionLifecycle("demo", "published", { skipEvalGate: true });
    expect(out.status).toBe("published");
    expect(current.skill.status).toBe("published");
  });

  it("does NOT run the gate when target is `deprecated`", async () => {
    const cases = [makeCase("a")];
    const latest = new Map<string, EvalRunStatus>(); // empty — would trip gate if it ran
    const { service, evalRepo, current } = setup({
      initial: makeSkill({ status: "published" }),
      cases,
      latest,
    });
    const out = await service.transitionLifecycle("demo", "deprecated");
    expect(out.status).toBe("deprecated");
    expect(current.skill.status).toBe("deprecated");
    expect(evalRepo.findLatestRunStatusByCase).not.toHaveBeenCalled();
  });

  it("does NOT run the gate when target is `archived`", async () => {
    const cases = [makeCase("a")];
    const { service, evalRepo, current } = setup({
      initial: makeSkill({ status: "draft" }),
      cases,
      latest: new Map(),
    });
    const out = await service.transitionLifecycle("demo", "archived");
    expect(out.status).toBe("archived");
    expect(current.skill.status).toBe("archived");
    expect(evalRepo.findLatestRunStatusByCase).not.toHaveBeenCalled();
  });

  it("runs the gate on republish (deprecated → published)", async () => {
    const cases = [makeCase("a")];
    const latest = new Map<string, EvalRunStatus>([["a", "fail"]]);
    const { service } = setup({
      initial: makeSkill({ status: "deprecated" }),
      cases,
      latest,
    });
    const err = await service.transitionLifecycle("demo", "published").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalRegressionError);
  });

  it("does NOT run the gate when evalRepo isn't wired (legacy callers)", async () => {
    const { service, current } = setup({
      initial: makeSkill({ status: "draft" }),
      withEvalRepo: false,
    });
    const out = await service.transitionLifecycle("demo", "published");
    expect(out.status).toBe("published");
    expect(current.skill.status).toBe("published");
  });

  it("collects multiple failing + untested cases together", async () => {
    const cases = [makeCase("a"), makeCase("b"), makeCase("c"), makeCase("d")];
    const latest = new Map<string, EvalRunStatus>([
      ["a", "pass"],
      ["b", "fail"],
      ["c", "error"],
      // d untested
    ]);
    const { service } = setup({
      initial: makeSkill({ status: "draft" }),
      cases,
      latest,
    });
    const err = await service.transitionLifecycle("demo", "published").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalRegressionError);
    const e = err as EvalRegressionError;
    expect(e.failingCases.sort()).toEqual(["b", "c"]);
    expect(e.untestedCases).toEqual(["d"]);
    expect(e.message).toMatch(/failing: b, c/);
    expect(e.message).toMatch(/untested: d/);
  });

  it("adminTransitionLifecycle threads skipEvalGate through", async () => {
    const cases = [makeCase("a")];
    const latest = new Map<string, EvalRunStatus>([["a", "fail"]]);
    const { service, current } = setup({
      initial: makeSkill({ status: "draft" }),
      cases,
      latest,
    });
    const out = await service.adminTransitionLifecycle("demo", "published", { skipEvalGate: true });
    expect(out.status).toBe("published");
    expect(current.skill.status).toBe("published");
  });
});
