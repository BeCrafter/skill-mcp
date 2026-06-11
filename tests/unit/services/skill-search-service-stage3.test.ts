import { describe, it, expect, vi } from "vitest";
import { SkillSearchService } from "../../../src/services/skill-search.service.js";
import {
  HashEmbeddingProvider,
  NullEmbeddingProvider,
  type IEmbeddingProvider,
} from "../../../src/retrieval/embedding-provider.js";

/**
 * P1-11 stage 3 — vector / hybrid search paths. Pins:
 *   - With NullEmbeddingProvider (default), all modes resolve to BM25 — the
 *     OSS distribution stays exactly stage-2b until an operator opts in.
 *   - rebuild() loads only embedding rows whose model_name + dimension match
 *     the active provider; stale-model rows are ignored (they get rebuilt
 *     by refreshOne on the next mutation).
 *   - refreshOne() re-embeds only when content_hash changed — keeps LLM
 *     bills bounded on cosmetic-only updates (e.g. tag tweaks).
 *   - searchAsync(vector|hybrid) embeds the query then queries the vector
 *     index; embedding failure or null fall back to BM25 instead of empty.
 *   - removeBySlug() drops the entry from BOTH indexes and clears the
 *     content-hash cache.
 */

const SKILL = (slug: string, extras: Record<string, unknown> = {}) => ({
  id: slug,
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
  const map = new Map(rows.map((r) => [r.slug, r]));
  return {
    findAll: vi.fn().mockImplementation(async () => Array.from(map.values())),
    findBySlug: vi.fn().mockImplementation(async (slug: string) => map.get(slug) ?? null),
    set: (row: ReturnType<typeof SKILL>) => map.set(row.slug, row),
  };
}

interface EmbedRepoRow {
  skillId: string;
  modelName: string;
  dimension: number;
  vector: Float32Array;
  contentHash: string | null;
}

function makeEmbeddingRepo(seed: EmbedRepoRow[] = []) {
  const map = new Map<string, EmbedRepoRow>();
  for (const r of seed) map.set(r.skillId, r);
  const upsert = vi.fn().mockImplementation((row: EmbedRepoRow) => {
    map.set(row.skillId, { ...row });
  });
  const findAll = vi.fn().mockImplementation(() => Array.from(map.values()));
  const findBySkillId = vi
    .fn()
    .mockImplementation((id: string) => map.get(id) ?? null);
  const del = vi.fn().mockImplementation((id: string) => {
    map.delete(id);
  });
  return { upsert, findAll, findBySkillId, delete: del, _map: map };
}

describe("SkillSearchService stage 3 — null provider default", () => {
  it("hasEmbeddingProvider() reports false with the default NullEmbeddingProvider", async () => {
    const repo = makeRepo([SKILL("a")]);
    const svc = new SkillSearchService(repo as never, makeLogger());
    expect(svc.hasEmbeddingProvider()).toBe(false);
    expect(svc.embeddingModelName()).toBe("null");
    await svc.init();
    expect(svc.vectorSize()).toBe(0);
  });

  it("searchAsync('vector') falls back to BM25 when no provider configured", async () => {
    const repo = makeRepo([SKILL("alpha", { description: "ripgrep helper" })]);
    const svc = new SkillSearchService(repo as never, makeLogger());
    await svc.init();
    const hits = await svc.searchAsync("ripgrep", { mode: "vector" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].skillId).toBe("alpha");
  });

  it("searchAsync('hybrid') falls back to BM25 when no provider configured", async () => {
    const repo = makeRepo([SKILL("alpha", { description: "ripgrep helper" })]);
    const svc = new SkillSearchService(repo as never, makeLogger());
    await svc.init();
    const hits = await svc.searchAsync("ripgrep", { mode: "hybrid" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].skillId).toBe("alpha");
  });
});

describe("SkillSearchService stage 3 — with HashEmbeddingProvider", () => {
  function build(rows: ReturnType<typeof SKILL>[], embedSeed: EmbedRepoRow[] = []) {
    const repo = makeRepo(rows);
    const provider = new HashEmbeddingProvider({ name: "hash-stub", dimension: 64 });
    const embedRepo = makeEmbeddingRepo(embedSeed);
    const svc = new SkillSearchService(repo as never, makeLogger(), {
      embeddingProvider: provider,
      embeddingRepo: embedRepo as never,
    });
    return { repo, provider, embedRepo, svc };
  }

  it("hasEmbeddingProvider() reports true when a real provider is wired", () => {
    const { svc } = build([SKILL("a")]);
    expect(svc.hasEmbeddingProvider()).toBe(true);
    expect(svc.embeddingModelName()).toBe("hash-stub");
  });

  it("rebuild() embeds skills lazily — no embeddings written by init alone", async () => {
    const { svc, embedRepo } = build([
      SKILL("alpha", { description: "ripgrep helper" }),
      SKILL("beta", { description: "postgresql backup" }),
    ]);
    await svc.init();
    // init() only hydrates from the embedding repo. The repo is empty so
    // vectorSize stays 0 until refreshOne or admin re-embed runs.
    expect(svc.size()).toBe(2);
    expect(svc.vectorSize()).toBe(0);
    expect(embedRepo.upsert).not.toHaveBeenCalled();
  });

  it("rebuild() loads only rows whose model_name + dimension match the provider", async () => {
    const v = (n: number) => {
      const arr = new Float32Array(64);
      arr[0] = 1;
      return arr;
    };
    const { svc } = build(
      [SKILL("alpha"), SKILL("beta"), SKILL("gamma")],
      [
        { skillId: "alpha", modelName: "hash-stub", dimension: 64, vector: v(0), contentHash: "h" },
        { skillId: "beta", modelName: "old-model", dimension: 64, vector: v(0), contentHash: "h" },
        { skillId: "gamma", modelName: "hash-stub", dimension: 32, vector: new Float32Array(32), contentHash: "h" },
      ],
    );
    await svc.init();
    // Only alpha matches BOTH model_name and dimension.
    expect(svc.vectorSize()).toBe(1);
  });

  it("refreshOne() embeds and persists when no prior embedding exists", async () => {
    const { svc, repo, embedRepo } = build([SKILL("alpha", { description: "ripgrep" })]);
    await svc.init();
    await svc.refreshOne("alpha");
    expect(svc.vectorSize()).toBe(1);
    expect(embedRepo.upsert).toHaveBeenCalledTimes(1);
    const args = embedRepo.upsert.mock.calls[0][0];
    expect(args.skillId).toBe("alpha");
    expect(args.modelName).toBe("hash-stub");
    expect(args.dimension).toBe(64);
    expect(args.contentHash).toBe("h");
    expect(args.vector.length).toBe(64);
    void repo;
  });

  it("refreshOne() does NOT re-embed when content_hash is unchanged", async () => {
    const { svc, embedRepo } = build([SKILL("alpha", { description: "ripgrep", contentHash: "h-stable" })]);
    await svc.init();
    // First call writes the row.
    await svc.refreshOne("alpha");
    expect(embedRepo.upsert).toHaveBeenCalledTimes(1);
    // Second call with unchanged hash MUST be a no-op (LLM cost guard).
    await svc.refreshOne("alpha");
    expect(embedRepo.upsert).toHaveBeenCalledTimes(1);
  });

  it("refreshOne() re-embeds when content_hash changes", async () => {
    const { svc, repo, embedRepo } = build([SKILL("alpha", { description: "ripgrep", contentHash: "h1" })]);
    await svc.init();
    await svc.refreshOne("alpha");
    expect(embedRepo.upsert).toHaveBeenCalledTimes(1);

    // Mutate hash + description and republish.
    repo.set(SKILL("alpha", { description: "fully different content", contentHash: "h2" }));
    await svc.refreshOne("alpha");
    expect(embedRepo.upsert).toHaveBeenCalledTimes(2);
  });

  it("refreshOne() drops embedding when provider returns null (e.g. unindexable text)", async () => {
    // Use a dummy provider that returns null for non-tokenizable text. Hash
    // provider already does this on whitespace-only input.
    const repo = makeRepo([SKILL("alpha", { description: "    ", name: "  " })]);
    const provider: IEmbeddingProvider = {
      name: "hash-stub",
      dimension: 64,
      async embed() { return null; },
      async embedBatch(texts: string[]) { return texts.map(() => null); },
    };
    const embedRepo = makeEmbeddingRepo([
      { skillId: "alpha", modelName: "hash-stub", dimension: 64, vector: new Float32Array(64).fill(0.125), contentHash: "h-old" },
    ]);
    const svc = new SkillSearchService(repo as never, makeLogger(), {
      embeddingProvider: provider,
      embeddingRepo: embedRepo as never,
    });
    await svc.init();
    expect(svc.vectorSize()).toBe(1);

    // Force re-embed via stale hash on the skill row.
    repo.set(SKILL("alpha", { description: "    ", contentHash: "h-new" }));
    await svc.refreshOne("alpha");
    expect(svc.vectorSize()).toBe(0);
    expect(embedRepo.delete).toHaveBeenCalledWith("alpha");
  });

  it("removeBySlug() drops both BM25 and vector entries", async () => {
    const repo = makeRepo([SKILL("alpha", { description: "ripgrep" })]);
    const provider = new HashEmbeddingProvider({ name: "hash-stub", dimension: 64 });
    const embedRepo = makeEmbeddingRepo();
    const svc = new SkillSearchService(repo as never, makeLogger(), {
      embeddingProvider: provider,
      embeddingRepo: embedRepo as never,
    });
    await svc.init();
    await svc.refreshOne("alpha");
    expect(svc.size()).toBe(1);
    expect(svc.vectorSize()).toBe(1);

    svc.removeBySlug("alpha");
    expect(svc.size()).toBe(0);
    expect(svc.vectorSize()).toBe(0);
  });

  it("searchAsync('vector') ranks via cosine over the embedding sidecar", async () => {
    const { svc } = build([
      SKILL("alpha", { description: "ripgrep search directory" }),
      SKILL("beta", { description: "postgresql database backup" }),
    ]);
    await svc.init();
    await svc.refreshOne("alpha");
    await svc.refreshOne("beta");
    expect(svc.vectorSize()).toBe(2);

    const hits = await svc.searchAsync("ripgrep search files", { mode: "vector" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].skillId).toBe("alpha");
  });

  it("searchAsync('hybrid') combines BM25 + vector — hits in both rank highest", async () => {
    const { svc } = build([
      SKILL("alpha", { description: "ripgrep search directory" }),
      SKILL("beta", { description: "postgresql database backup" }),
    ]);
    await svc.init();
    await svc.refreshOne("alpha");
    await svc.refreshOne("beta");

    const hits = await svc.searchAsync("ripgrep", { mode: "hybrid", hybridAlpha: 0.5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].skillId).toBe("alpha");
  });

  it("searchAsync falls back to BM25 when query embedding throws", async () => {
    const repo = makeRepo([SKILL("alpha", { description: "ripgrep helper" })]);
    const provider: IEmbeddingProvider = {
      name: "hash-stub",
      dimension: 64,
      async embed() { throw new Error("boom"); },
      async embedBatch(texts: string[]) { return texts.map(() => null); },
    };
    const embedRepo = makeEmbeddingRepo();
    const svc = new SkillSearchService(repo as never, makeLogger(), {
      embeddingProvider: provider,
      embeddingRepo: embedRepo as never,
    });
    await svc.init();
    const hits = await svc.searchAsync("ripgrep", { mode: "vector" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].skillId).toBe("alpha");
  });

  it("searchAsync falls back to BM25 when query embedding returns null", async () => {
    const repo = makeRepo([SKILL("alpha", { description: "ripgrep helper" })]);
    const provider: IEmbeddingProvider = {
      name: "hash-stub",
      dimension: 64,
      async embed() { return null; },
      async embedBatch(texts: string[]) { return texts.map(() => null); },
    };
    const embedRepo = makeEmbeddingRepo();
    const svc = new SkillSearchService(repo as never, makeLogger(), {
      embeddingProvider: provider,
      embeddingRepo: embedRepo as never,
    });
    await svc.init();
    const hits = await svc.searchAsync("ripgrep", { mode: "vector" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].skillId).toBe("alpha");
  });

  it("sync search() with non-BM25 mode falls back to BM25 (logs debug)", async () => {
    const logger = makeLogger();
    const repo = makeRepo([SKILL("alpha", { description: "ripgrep helper" })]);
    const provider = new HashEmbeddingProvider({ name: "hash-stub", dimension: 64 });
    const embedRepo = makeEmbeddingRepo();
    const svc = new SkillSearchService(repo as never, logger, {
      embeddingProvider: provider,
      embeddingRepo: embedRepo as never,
    });
    await svc.init();

    const hits = svc.search("ripgrep", { mode: "vector" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].skillId).toBe("alpha");
    // debug log emitted explaining the fallback
    expect((logger as never as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalled();
  });
});

describe("SkillSearchService stage 3 — null-provider with embedding repo seeded", () => {
  it("ignores all seeded embeddings (provider.dimension==0 short-circuits hydration)", async () => {
    const repo = makeRepo([SKILL("alpha")]);
    const embedRepo = makeEmbeddingRepo([
      { skillId: "alpha", modelName: "null", dimension: 0, vector: new Float32Array(0), contentHash: "h" },
    ]);
    const svc = new SkillSearchService(repo as never, makeLogger(), {
      embeddingProvider: new NullEmbeddingProvider(),
      embeddingRepo: embedRepo as never,
    });
    await svc.init();
    expect(svc.vectorSize()).toBe(0);
  });
});
