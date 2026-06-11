import { describe, it, expect, vi } from "vitest";
import { SkillSearchService } from "../../../src/services/skill-search.service.js";
import { DomainEventBus } from "../../../src/events/event-bus.js";

/**
 * P1-11 stage 2b — SkillSearchService lifecycle suite. Pins the contracts
 * the rest of the system depends on:
 *   - init() is idempotent and hydrates the index from skillRepo.findAll()
 *   - refreshOne() upserts and tolerates a deleted-mid-event row
 *   - removeBySlug() resolves through the slug→id sidemap (no DB lookup)
 *   - subscribe() wires every mutation event to the right handler
 *   - search() soft-fails to [] before init() completes
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
  status: "draft",
  visibility: "private",
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

function makeRepo(rows: ReturnType<typeof SKILL>[]) {
  const map = new Map(rows.map(r => [r.slug, r]));
  return {
    findAll: vi.fn().mockImplementation(async () => Array.from(map.values())),
    findBySlug: vi.fn().mockImplementation(async (slug: string) => map.get(slug) ?? null),
    set: (row: ReturnType<typeof SKILL>) => map.set(row.slug, row),
    delete: (slug: string) => map.delete(slug),
  };
}

describe("SkillSearchService", () => {
  describe("init()", () => {
    it("hydrates the index from findAll() and is idempotent", async () => {
      const repo = makeRepo([SKILL("alpha"), SKILL("beta")]);
      const svc = new SkillSearchService(repo as never, makeLogger());
      expect(svc.isReady()).toBe(false);
      await svc.init();
      expect(svc.isReady()).toBe(true);
      expect(svc.size()).toBe(2);
      expect(repo.findAll).toHaveBeenCalledTimes(1);
      // Second init() must not re-fetch — idempotent guard prevents double load.
      await svc.init();
      expect(repo.findAll).toHaveBeenCalledTimes(1);
    });

    it("dedupes concurrent init() callers via inflight promise", async () => {
      const repo = makeRepo([SKILL("a")]);
      const svc = new SkillSearchService(repo as never, makeLogger());
      await Promise.all([svc.init(), svc.init(), svc.init()]);
      expect(repo.findAll).toHaveBeenCalledTimes(1);
      expect(svc.size()).toBe(1);
    });
  });

  describe("rebuild()", () => {
    it("clears stale entries before reloading", async () => {
      const repo = makeRepo([SKILL("a"), SKILL("b")]);
      const svc = new SkillSearchService(repo as never, makeLogger());
      await svc.init();
      expect(svc.size()).toBe(2);

      repo.delete("a");
      repo.set(SKILL("c"));
      await svc.rebuild();
      expect(svc.size()).toBe(2);
      // a should be gone — searching for its name yields nothing.
      expect(svc.search("a")).toEqual([]);
      expect(svc.search("c").length).toBe(1);
    });
  });

  describe("refreshOne()", () => {
    it("upserts the indexed text from the latest DB row", async () => {
      const repo = makeRepo([SKILL("a", "id-a", { description: "old text" })]);
      const svc = new SkillSearchService(repo as never, makeLogger());
      await svc.init();
      expect(svc.search("old").length).toBe(1);

      repo.set(SKILL("a", "id-a", { description: "fresh content" }));
      await svc.refreshOne("a");
      expect(svc.search("old")).toEqual([]);
      expect(svc.search("fresh").length).toBe(1);
    });

    it("treats a vanished row as a delete using the cached id", async () => {
      const repo = makeRepo([SKILL("a", "id-a")]);
      const svc = new SkillSearchService(repo as never, makeLogger());
      await svc.init();
      expect(svc.size()).toBe(1);

      repo.delete("a");
      await svc.refreshOne("a");
      expect(svc.size()).toBe(0);
      expect(svc.search("a")).toEqual([]);
    });

    it("no-ops for an unknown slug with no cached id", async () => {
      const repo = makeRepo([]);
      const svc = new SkillSearchService(repo as never, makeLogger());
      await svc.init();
      await svc.refreshOne("nonexistent");
      expect(svc.size()).toBe(0);
    });
  });

  describe("removeBySlug()", () => {
    it("removes via the cached slug→id sidemap (no DB hit)", async () => {
      const repo = makeRepo([SKILL("a", "id-a"), SKILL("b", "id-b")]);
      const svc = new SkillSearchService(repo as never, makeLogger());
      await svc.init();

      svc.removeBySlug("a");
      expect(svc.size()).toBe(1);
      expect(svc.search("a")).toEqual([]);
      expect(svc.search("b").length).toBe(1);
      // No additional findBySlug calls — the sidemap is the whole point.
      expect(repo.findBySlug).toHaveBeenCalledTimes(0);
    });

    it("ignores unknown slug", async () => {
      const repo = makeRepo([SKILL("a")]);
      const svc = new SkillSearchService(repo as never, makeLogger());
      await svc.init();
      svc.removeBySlug("ghost");
      expect(svc.size()).toBe(1);
    });
  });

  describe("subscribe()", () => {
    it("wires skill:created/updated/imported to upsert, skill:deleted to remove", async () => {
      const repo = makeRepo([SKILL("a", "id-a")]);
      const svc = new SkillSearchService(repo as never, makeLogger());
      await svc.init();
      const bus = new DomainEventBus();
      svc.subscribe(bus);

      // Add a new row + publish skill:created → indexed.
      repo.set(SKILL("b", "id-b", { description: "newcomer" }));
      bus.publish({ type: "skill:created", slug: "b" });
      // Async handler — wait one tick so the await chain settles.
      await new Promise(r => setImmediate(r));
      expect(svc.search("newcomer").length).toBe(1);

      // Mutate + publish skill:updated → re-indexed.
      repo.set(SKILL("b", "id-b", { description: "mutated body" }));
      bus.publish({ type: "skill:updated", slug: "b" });
      await new Promise(r => setImmediate(r));
      expect(svc.search("newcomer")).toEqual([]);
      expect(svc.search("mutated").length).toBe(1);

      // skill:imported → upsert.
      repo.set(SKILL("c", "id-c", { description: "imported skill" }));
      bus.publish({ type: "skill:imported", slug: "c" });
      await new Promise(r => setImmediate(r));
      expect(svc.search("imported").length).toBe(1);

      // skill:deleted is sync (sidemap lookup) — remove immediately.
      bus.publish({ type: "skill:deleted", slug: "b" });
      expect(svc.search("mutated")).toEqual([]);
    });

    it("listener errors do not propagate (logged via the bus)", async () => {
      const repo = {
        findAll: vi.fn().mockResolvedValue([]),
        findBySlug: vi.fn().mockRejectedValue(new Error("boom")),
      };
      const logger = makeLogger();
      const svc = new SkillSearchService(repo as never, logger);
      await svc.init();
      const bus = new DomainEventBus();
      svc.subscribe(bus);

      // Should not throw — handler swallows + logs.
      bus.publish({ type: "skill:updated", slug: "anything" });
      await new Promise(r => setImmediate(r));
      // The handler logs warn on the SkillSearchService logger.
      expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
    });
  });

  describe("search()", () => {
    it("soft-fails to [] when not yet ready", async () => {
      const repo = makeRepo([SKILL("a")]);
      const logger = makeLogger();
      const svc = new SkillSearchService(repo as never, logger);
      // Note: no init() call — service is not ready.
      const hits = svc.search("a");
      expect(hits).toEqual([]);
      expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
    });

    it("ranks by BM25 once initialised", async () => {
      const repo = makeRepo([
        SKILL("a", "id-a", { description: "ripgrep ripgrep ripgrep search" }),
        SKILL("b", "id-b", { description: "ripgrep once" }),
      ]);
      const svc = new SkillSearchService(repo as never, makeLogger());
      await svc.init();
      const hits = svc.search("ripgrep");
      expect(hits[0].skillId).toBe("id-a");
      expect(hits.length).toBe(2);
    });

    it("forwards limit option", async () => {
      const rows = Array.from({ length: 5 }, (_, i) => SKILL(`s${i}`, `id-${i}`, { description: "common" }));
      const repo = makeRepo(rows);
      const svc = new SkillSearchService(repo as never, makeLogger());
      await svc.init();
      expect(svc.search("common", { limit: 2 }).length).toBe(2);
    });

    it("includes triggers / whenToUse / embeddingText in indexed text", async () => {
      const repo = makeRepo([
        SKILL("a", "id-a", {
          description: "noise",
          retrievalMeta: { triggers: ["needle"], whenToUse: "uses needle", embeddingText: "" },
        }),
      ]);
      const svc = new SkillSearchService(repo as never, makeLogger());
      await svc.init();
      expect(svc.search("needle").length).toBe(1);
    });
  });
});
