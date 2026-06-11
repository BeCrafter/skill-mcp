import { describe, it, expect, vi } from "vitest";
import { SkillService, IllegalTransitionError } from "@/services/skill.service.js";
import type { ISkillProvider } from "@/provider/interface.js";
import type { ICacheProvider } from "@/cache/provider.interface.js";
import type { SkillRepository } from "@/db/repositories/skill.repository.js";
import type { Logger } from "pino";
import type { SkillMeta, SkillStatus } from "@/types/index.js";
import { CacheEpochManager } from "@/cache/cache-epochs.js";
import { SkillNotFoundError } from "@/utils/errors.js";

function makeSkill(overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    id: "1", slug: "demo", name: "demo",
    displayName: null, description: "",
    version: "0.0.1", category: null, tags: [], attributes: {},
    status: "draft", visibility: "private", entryFile: "SKILL.md",
    storagePath: "demo/", contentHash: null,
    createdAt: 0, updatedAt: 0,
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

function setup(initial: SkillMeta = makeSkill()) {
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
  const epochs = new CacheEpochManager();
  const service = new SkillService(
    provider, cache, silentLogger(),
    undefined, undefined, undefined,
    skillRepo, undefined, epochs,
  );
  return { service, skillRepo, epochs, current };
}

describe("SkillService.transitionLifecycle (P0-9)", () => {
  it("transitions draft → published and persists status", async () => {
    const { service, skillRepo, current } = setup(makeSkill({ status: "draft" }));
    const out = await service.transitionLifecycle("demo", "published");
    expect(out.status).toBe("published");
    expect(skillRepo.update).toHaveBeenCalledWith("1", { status: "published" });
    expect(current.skill.status).toBe("published");
  });

  it("bumps the global cache epoch so non-admin lists drop the skill on next read", async () => {
    const { service, epochs } = setup(makeSkill({ status: "published" }));
    const before = epochs.getGlobalEpoch();
    await service.transitionLifecycle("demo", "deprecated");
    expect(epochs.getGlobalEpoch()).toBe(before + 1);
  });

  it("rejects illegal transition with IllegalTransitionError", async () => {
    const { service } = setup(makeSkill({ status: "archived" }));
    await expect(service.transitionLifecycle("demo", "published"))
      .rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it("rejects no-op (same state) transition", async () => {
    const { service } = setup(makeSkill({ status: "published" }));
    await expect(service.transitionLifecycle("demo", "published"))
      .rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it("throws SkillNotFoundError for missing skill", async () => {
    const { service } = setup();
    await expect(service.transitionLifecycle("nope", "published"))
      .rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("supports republish (deprecated → published)", async () => {
    const { service, current } = setup(makeSkill({ status: "deprecated" }));
    const out = await service.transitionLifecycle("demo", "published");
    expect(out.status).toBe("published");
    expect(current.skill.status).toBe("published");
  });

  it("archive is terminal — subsequent transitions all fail", async () => {
    const { service } = setup(makeSkill({ status: "draft" }));
    await service.transitionLifecycle("demo", "archived");
    for (const target of ["published", "deprecated", "draft"] as SkillStatus[]) {
      await expect(service.transitionLifecycle("demo", target))
        .rejects.toBeInstanceOf(IllegalTransitionError);
    }
  });
});

describe("SkillService.getNextLifecycleStates (P0-9)", () => {
  it("returns the legal next states for a draft skill", async () => {
    const { service } = setup(makeSkill({ status: "draft" }));
    const out = await service.getNextLifecycleStates("demo");
    expect(out.current).toBe("draft");
    expect(out.next.sort()).toEqual(["archived", "published"]);
  });

  it("returns empty next list for archived skills", async () => {
    const { service } = setup(makeSkill({ status: "archived" }));
    const out = await service.getNextLifecycleStates("demo");
    expect(out).toEqual({ current: "archived", next: [] });
  });
});
