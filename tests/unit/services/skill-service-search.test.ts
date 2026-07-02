import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillService } from "@/services/skill.service.js";
import { BadRequestError, ConfigurationError, SkillNotFoundError } from "@/utils/errors.js";

/**
 * P1-11 stage 2b — service-layer search contract suite. Pins:
 *   - permission filter runs *before* BM25 ranking (so high-score privates
 *     never leak to low-tag callers)
 *   - listAccessibleSkills({query}) returns hits in BM25 order when the
 *     SkillSearchService is wired and ready
 *   - listSkillsIndex(ctx, tags, query) honours the query path and skips
 *     the effectiveness-rate sort
 *   - rankByQuery falls back to a substring scan when no searchService is
 *     present (cloud / unit tests)
 *   - adminUpdateRetrievalMeta merges patches, accepts null to clear, and
 *     rejects oversize fields with BadRequestError
 */

const SKILL = (slug: string, id = slug, extras: Record<string, unknown> = {}) => ({
  id,
  slug,
  name: slug,
  displayName: null,
  description: `desc for ${slug}`,
  version: "0.0.1",
  category: null,
  tags: [],
  attributes: {},
  status: "published",
  visibility: "public",
  entryFile: "SKILL.md",
  storagePath: `${slug}/`,
  contentHash: "h",
  createdAt: 1,
  updatedAt: 1,
  retrievalMeta: null,
  ...extras,
});

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

function makeCache() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: unknown) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
    clear: vi.fn(async () => { store.clear(); }),
    clearByPrefix: vi.fn(async () => {}),
  };
}

function makeProvider(skills: ReturnType<typeof SKILL>[]) {
  return { listSkills: vi.fn().mockResolvedValue(skills) } as never;
}

function makeService(opts: {
  skills?: ReturnType<typeof SKILL>[];
  searchService?: unknown;
  skillRepo?: unknown;
  eventBus?: unknown;
} = {}) {
  return new SkillService(
    makeProvider(opts.skills ?? []),
    makeCache() as never,
    makeLogger(),
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    { getEffectivenessRates: vi.fn().mockResolvedValue(new Map()) } as never,
    {} as never,
    (opts.skillRepo ?? null) as never,
    {} as never,
    undefined,
    undefined,
    {
      searchService: opts.searchService as never,
      eventBus: opts.eventBus as never,
    },
  );
}

const ANON_CTX = {
  userId: "anonymous",
  sessionId: "anonymous",
  tags: new Set<string>(),
  isAuthenticated: false,
};

describe("SkillService — search (P1-11 stage 2b)", () => {
  describe("rankByQuery — substring fallback (no searchService)", () => {
    it("filters by case-insensitive substring on name + description", async () => {
      const skills = [
        SKILL("alpha", "id-a", { description: "matches the NEEDLE here" }),
        SKILL("beta", "id-b", { description: "no relevant content" }),
        SKILL("gamma", "id-g", { description: "another needle reference" }),
      ];
      const svc = makeService({ skills });
      const out = await svc.listAccessibleSkills(ANON_CTX, { query: "needle" });
      expect(out.map(s => s.slug).sort()).toEqual(["alpha", "gamma"]);
    });

    it("returns empty when nothing matches", async () => {
      const svc = makeService({ skills: [SKILL("a"), SKILL("b")] });
      const out = await svc.listAccessibleSkills(ANON_CTX, { query: "zzznonexistent" });
      expect(out).toEqual([]);
    });
  });

  describe("rankByQuery — BM25 path (searchService ready)", () => {
    it("orders results by BM25 hits when service is ready", async () => {
      const skills = [
        SKILL("alpha", "id-a"),
        SKILL("beta", "id-b"),
        SKILL("gamma", "id-g"),
      ];
      const fakeSearch = {
        isReady: () => true,
        search: vi.fn().mockReturnValue([
          { skillId: "id-g", score: 5.5 },
          { skillId: "id-a", score: 2.1 },
        ]),
      };
      const svc = makeService({ skills, searchService: fakeSearch });
      const hits = await svc.searchAccessibleSkills(ANON_CTX, "anything");
      expect(hits.map(h => h.skill.slug)).toEqual(["gamma", "alpha"]);
      expect(hits[0].score).toBe(5.5);
      expect(fakeSearch.search).toHaveBeenCalled();
    });

    it("falls back to substring when searchService.isReady() is false", async () => {
      const skills = [SKILL("alpha", "id-a", { description: "matches the needle here" })];
      const fakeSearch = { isReady: () => false, search: vi.fn() };
      const svc = makeService({ skills, searchService: fakeSearch });
      const hits = await svc.searchAccessibleSkills(ANON_CTX, "needle");
      expect(hits.map(h => h.skill.slug)).toEqual(["alpha"]);
      expect(fakeSearch.search).not.toHaveBeenCalled();
    });

    it("respects the limit option", async () => {
      const skills = Array.from({ length: 10 }, (_, i) => SKILL(`s${i}`, `id-${i}`));
      const fakeSearch = {
        isReady: () => true,
        search: vi.fn().mockReturnValue(
          skills.map((_, i) => ({ skillId: `id-${i}`, score: 10 - i })),
        ),
      };
      const svc = makeService({ skills, searchService: fakeSearch });
      const hits = await svc.searchAccessibleSkills(ANON_CTX, "x", { limit: 3 });
      expect(hits.length).toBe(3);
    });
  });

  describe("permission filter precedes ranking", () => {
    it("private skills are never ranked, even at high score", async () => {
      const skills = [
        SKILL("public-a", "id-pa", { visibility: "public" }),
        SKILL("private-b", "id-pb", { visibility: "private", tags: ["secret"] }),
      ];
      // Anonymous (no tags) → can see public, cannot see tagged private.
      const fakeSearch = {
        isReady: () => true,
        // The fake returns the private id with high score; service must drop it.
        search: vi.fn().mockReturnValue([
          { skillId: "id-pb", score: 99 },
          { skillId: "id-pa", score: 0.5 },
        ]),
      };
      const svc = makeService({ skills, searchService: fakeSearch });
      const hits = await svc.searchAccessibleSkills(ANON_CTX, "x");
      // Only public-a survives the permission filter.
      expect(hits.map(h => h.skill.slug)).toEqual(["public-a"]);
    });
  });

  describe("listSkillsIndex query path", () => {
    it("formats only published hits, skipping effectiveness sort", async () => {
      const skills = [
        SKILL("alpha", "id-a", { status: "published", description: "ripgrep-style match" }),
        SKILL("draft-skill", "id-d", { status: "draft", description: "drafted ripgrep" }),
      ];
      const svc = makeService({ skills });
      const text = await svc.listSkillsIndex(ANON_CTX, undefined, "ripgrep");
      expect(text).toContain("alpha");
      expect(text).toContain("[id:id-a]");
      // Drafts must be omitted.
      expect(text).not.toContain("draft-skill");
    });

    it("returns empty string when query has no matches", async () => {
      const svc = makeService({ skills: [SKILL("a"), SKILL("b")] });
      const text = await svc.listSkillsIndex(ANON_CTX, undefined, "absolutely-no-match-zzzz");
      expect(text).toBe("");
    });
  });

  describe("adminUpdateRetrievalMeta", () => {
    let skillRepo: { findBySlug: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    let eventBus: { publish: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      skillRepo = {
        findBySlug: vi.fn(),
        update: vi.fn().mockImplementation(async (_id, patch) => ({
          ...SKILL("demo", "id-demo"),
          retrievalMeta: patch.retrievalMeta,
        })),
      };
      eventBus = { publish: vi.fn() };
    });

    it("merges partial patches with existing retrievalMeta", async () => {
      skillRepo.findBySlug.mockResolvedValue({
        ...SKILL("demo", "id-demo"),
        retrievalMeta: { triggers: ["existing"], whenToUse: "existing usage", embeddingText: "existing emb" },
      });
      const svc = makeService({ skillRepo, eventBus });
      await svc.adminUpdateRetrievalMeta("demo", { triggers: ["new"] });
      const call = skillRepo.update.mock.calls[0][1];
      expect(call.retrievalMeta).toEqual({
        triggers: ["new"],
        whenToUse: "existing usage",
        embeddingText: "existing emb",
      });
      expect(eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: "skill:updated", slug: "demo" }));
    });

    it("clears all fields when patch is null", async () => {
      skillRepo.findBySlug.mockResolvedValue({
        ...SKILL("demo", "id-demo"),
        retrievalMeta: { triggers: ["x"] },
      });
      const svc = makeService({ skillRepo, eventBus });
      await svc.adminUpdateRetrievalMeta("demo", null);
      expect(skillRepo.update.mock.calls[0][1].retrievalMeta).toBeNull();
    });

    it("rejects > 32 triggers", async () => {
      skillRepo.findBySlug.mockResolvedValue({ ...SKILL("demo", "id-demo"), retrievalMeta: null });
      const svc = makeService({ skillRepo, eventBus });
      const tooMany = Array.from({ length: 33 }, (_, i) => `t${i}`);
      await expect(svc.adminUpdateRetrievalMeta("demo", { triggers: tooMany })).rejects.toBeInstanceOf(BadRequestError);
    });

    it("rejects trigger entry > 128 chars", async () => {
      skillRepo.findBySlug.mockResolvedValue({ ...SKILL("demo", "id-demo"), retrievalMeta: null });
      const svc = makeService({ skillRepo, eventBus });
      const huge = "x".repeat(129);
      await expect(svc.adminUpdateRetrievalMeta("demo", { triggers: [huge] })).rejects.toBeInstanceOf(BadRequestError);
    });

    it("rejects whenToUse > 2048 chars", async () => {
      skillRepo.findBySlug.mockResolvedValue({ ...SKILL("demo", "id-demo"), retrievalMeta: null });
      const svc = makeService({ skillRepo, eventBus });
      await expect(svc.adminUpdateRetrievalMeta("demo", { whenToUse: "x".repeat(2049) })).rejects.toBeInstanceOf(BadRequestError);
    });

    it("rejects embeddingText > 8192 chars", async () => {
      skillRepo.findBySlug.mockResolvedValue({ ...SKILL("demo", "id-demo"), retrievalMeta: null });
      const svc = makeService({ skillRepo, eventBus });
      await expect(svc.adminUpdateRetrievalMeta("demo", { embeddingText: "x".repeat(8193) })).rejects.toBeInstanceOf(BadRequestError);
    });

    it("rejects non-string trigger entries", async () => {
      skillRepo.findBySlug.mockResolvedValue({ ...SKILL("demo", "id-demo"), retrievalMeta: null });
      const svc = makeService({ skillRepo, eventBus });
      await expect(svc.adminUpdateRetrievalMeta("demo", { triggers: [123 as unknown as string] })).rejects.toBeInstanceOf(BadRequestError);
    });

    it("throws SkillNotFoundError when slug missing", async () => {
      skillRepo.findBySlug.mockResolvedValue(null);
      const svc = makeService({ skillRepo, eventBus });
      await expect(svc.adminUpdateRetrievalMeta("ghost", { triggers: [] })).rejects.toBeInstanceOf(SkillNotFoundError);
    });

    it("throws ConfigurationError when skillRepo is unwired", async () => {
      const svc = makeService({});
      await expect(svc.adminUpdateRetrievalMeta("demo", null)).rejects.toBeInstanceOf(ConfigurationError);
    });
  });
});
