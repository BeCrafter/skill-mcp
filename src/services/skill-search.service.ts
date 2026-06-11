import type { Logger } from "pino";
import type { SkillRepository } from "../db/repositories/skill.repository.js";
import type { SkillEmbeddingRepository } from "../db/repositories/skill-embedding.repository.js";
import type { DomainEventBus } from "../events/event-bus.js";
import { BM25Index, buildIndexText, type SearchHit } from "../retrieval/bm25-index.js";
import { VectorIndex } from "../retrieval/vector-index.js";
import { combineHybrid, type HybridScoringOptions } from "../retrieval/hybrid-scorer.js";
import { NullEmbeddingProvider, type IEmbeddingProvider } from "../retrieval/embedding-provider.js";

/**
 * P1-11 stages 2b + 3 — owns the lifecycle of the BM25 index AND the
 * vector index. Loads both corpora once at startup, then rebuilds
 * individual rows on `skill:imported` / `skill:updated` and removes them
 * on `skill:deleted`.
 *
 * Stage 3 changes:
 *  - Optional `embeddingProvider` + `embeddingRepo`. Default provider is
 *    `NullEmbeddingProvider` (no-op) so deployments that don't configure
 *    an embedding model behave exactly like stage 2b.
 *  - `init()` hydrates the in-memory VectorIndex from `skill_embeddings`,
 *    skipping any rows whose `model_name` doesn't match the active
 *    provider — those rows are stale (the operator swapped models) and
 *    will be backfilled by `refreshOne()` on the next mutation, or by
 *    an admin-triggered `rebuild()`.
 *  - `refreshOne()` re-computes the embedding only when content_hash
 *    changed *or* model_name changed. Skipping unchanged content keeps
 *    LLM-API costs bounded.
 *  - `search()` accepts `mode: "bm25" | "vector" | "hybrid"`. Default is
 *    "bm25" for back-compat. "hybrid" combines BM25 + vector via
 *    `combineHybrid` with operator-tunable α.
 *
 * The slug↔id sidemap is here (not in the indexes themselves) so each
 * index stays a pure scoring data structure that knows nothing about
 * how the service models a skill.
 */
export type SearchMode = "bm25" | "vector" | "hybrid";

export interface SearchOptions {
  limit?: number;
  minScore?: number;
  /** P1-11 stage 3 — selects ranking signal. Defaults to "bm25" so
   *  callers who don't opt in continue to behave exactly like stage 2b.
   *  Falls back to "bm25" automatically when "vector"/"hybrid" is asked
   *  for but the embedding provider is the null no-op. */
  mode?: SearchMode;
  /** P1-11 stage 3 — weight on BM25 in hybrid mode. Range [0, 1]. */
  hybridAlpha?: number;
}

export class SkillSearchService {
  private readonly index = new BM25Index();
  private readonly vectorIndex = new VectorIndex();
  private readonly slugToId = new Map<string, string>();
  /** Per-skill content_hash recorded at the time the embedding was written.
   *  Lets `refreshOne()` skip re-embedding when content didn't actually
   *  change. Populated from DB on init() and updated whenever we embed. */
  private readonly embeddingContentHashes = new Map<string, string | null>();
  private ready = false;
  private rebuildInflight: Promise<void> | null = null;
  private readonly embeddingProvider: IEmbeddingProvider;
  private readonly embeddingRepo: SkillEmbeddingRepository | null;

  constructor(
    private skillRepo: SkillRepository,
    private logger: Logger,
    opts: { embeddingProvider?: IEmbeddingProvider; embeddingRepo?: SkillEmbeddingRepository } = {},
  ) {
    this.embeddingProvider = opts.embeddingProvider ?? new NullEmbeddingProvider();
    this.embeddingRepo = opts.embeddingRepo ?? null;
  }

  /** Build the initial corpus. Idempotent — repeated calls are no-ops once
   *  ready. Called from serve-cmd.ts during startup, after the repo is
   *  hydrated and before the first MCP/HTTP request lands. */
  async init(): Promise<void> {
    if (this.ready) return;
    if (this.rebuildInflight) return this.rebuildInflight;
    this.rebuildInflight = this.rebuild();
    await this.rebuildInflight;
    this.ready = true;
    this.rebuildInflight = null;
  }

  /** Drop the existing index and reload every skill row. Used by init() and
   *  by admin "rebuild index" actions for incident response.
   *
   *  Vector hydration: pulls every embedding row whose `model_name` matches
   *  the active provider; rows from a previous model are ignored (they'll
   *  be replaced lazily by `refreshOne()` on the next mutation, or wholesale
   *  by an admin re-embed). When no embeddingProvider is configured, the
   *  vector index simply stays empty. */
  async rebuild(): Promise<void> {
    const skills = await this.skillRepo.findAll();
    this.index.clear();
    this.vectorIndex.clear();
    this.slugToId.clear();
    this.embeddingContentHashes.clear();
    for (const skill of skills) {
      this.index.upsert(skill.id, buildIndexText(skill));
      this.slugToId.set(skill.slug, skill.id);
    }
    if (this.embeddingRepo && this.embeddingProvider.dimension > 0) {
      const rows = this.embeddingRepo.findAll();
      let loaded = 0;
      for (const row of rows) {
        if (row.modelName !== this.embeddingProvider.name) continue;
        if (row.dimension !== this.embeddingProvider.dimension) continue;
        try {
          this.vectorIndex.upsert(row.skillId, row.vector);
          this.embeddingContentHashes.set(row.skillId, row.contentHash);
          loaded += 1;
        } catch (err) {
          // Corrupt vector — log and skip; the next mutation will repopulate.
          this.logger.warn({ err, skillId: row.skillId }, "skipping corrupt embedding row");
        }
      }
      this.logger.info({ skills: skills.length, vectors: loaded }, "search index rebuilt");
    } else {
      this.logger.info({ count: skills.length }, "BM25 index rebuilt (vector path disabled)");
    }
  }

  /** Re-index one skill from the DB. Tolerant of a missing slug — used as
   *  the upsert path on `skill:created` / `skill:updated` / `skill:imported`.
   *
   *  Vector path is best-effort: if `embeddingProvider.embed()` fails or
   *  returns null, the BM25 path still completes (so search keeps working)
   *  and the warn log surfaces the failure. */
  async refreshOne(slug: string): Promise<void> {
    const skill = await this.skillRepo.findBySlug(slug);
    if (!skill) {
      // Row vanished between event publish and our refresh — treat as a
      // delete using the cached id so the index still converges.
      const cachedId = this.slugToId.get(slug);
      if (cachedId) {
        this.index.remove(cachedId);
        this.vectorIndex.remove(cachedId);
        this.embeddingContentHashes.delete(cachedId);
        this.slugToId.delete(slug);
      }
      return;
    }
    const text = buildIndexText(skill);
    this.index.upsert(skill.id, text);
    this.slugToId.set(skill.slug, skill.id);

    if (this.embeddingRepo && this.embeddingProvider.dimension > 0) {
      const previousHash = this.embeddingContentHashes.get(skill.id);
      const currentHash = skill.contentHash ?? null;
      // Re-embed only when content_hash changed or there's no embedding yet.
      // Spares us the LLM round-trip when an unrelated field (e.g. tags)
      // changed via update().
      if (previousHash === undefined || previousHash !== currentHash) {
        try {
          const vector = await this.embeddingProvider.embed(text);
          if (vector) {
            this.vectorIndex.upsert(skill.id, vector);
            this.embeddingRepo.upsert({
              skillId: skill.id,
              modelName: this.embeddingProvider.name,
              dimension: this.embeddingProvider.dimension,
              vector,
              contentHash: currentHash,
            });
            this.embeddingContentHashes.set(skill.id, currentHash);
          } else {
            // Provider can't emit (empty text / model unavailable). Drop
            // any stale vector so we don't keep returning hits backed by
            // long-deleted content.
            this.vectorIndex.remove(skill.id);
            this.embeddingRepo.delete(skill.id);
            this.embeddingContentHashes.delete(skill.id);
          }
        } catch (err) {
          this.logger.warn({ err, slug: skill.slug }, "embedding refresh failed");
        }
      }
    }
  }

  /** Remove a skill by slug. Used by the `skill:deleted` handler — looks
   *  up the cached id (the row is gone from DB by the time the event fires
   *  in async-dispatch mode) so the index stays consistent without a
   *  full rebuild. */
  removeBySlug(slug: string): void {
    const id = this.slugToId.get(slug);
    if (!id) return;
    this.index.remove(id);
    this.vectorIndex.remove(id);
    this.embeddingContentHashes.delete(id);
    this.slugToId.delete(slug);
    // The `skill_embeddings` row is dropped by ON DELETE CASCADE when
    // SkillRepository.delete fires; we don't double-write here.
  }

  /** Subscribe to mutation events. Errors inside the handler are logged
   *  via the bus's listener-isolation try/catch, so a transient DB hiccup
   *  during refreshOne won't break sibling subscribers (cache, webhook). */
  subscribe(bus: DomainEventBus): void {
    const upsertHandler = async (event: { slug: string }) => {
      try {
        await this.refreshOne(event.slug);
      } catch (err) {
        this.logger.warn({ err, slug: event.slug }, "BM25 index refresh failed");
      }
    };
    bus.on("skill:created", upsertHandler);
    bus.on("skill:updated", upsertHandler);
    bus.on("skill:imported", upsertHandler);
    bus.on("skill:deleted", (event) => {
      this.removeBySlug(event.slug);
    });
  }

  /** Run a query. Returns ranked hits; caller is responsible for permission
   *  filtering and DB hydration of the resulting ids.
   *
   *  Mode behaviour:
   *   - "bm25" (default): keyword index only, identical to stage 2b.
   *   - "vector": cosine similarity only. Falls back to "bm25" automatically
   *     when no embedding provider is configured (NullEmbeddingProvider) —
   *     surprises callers less than returning an empty array.
   *   - "hybrid": min-max normalize both lists and combine with α weight.
   *     Same fallback rule as "vector".
   *
   *  When `!isReady()`, soft-fail with `[]` regardless of mode. Same
   *  semantics as stage 2b. */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    if (!this.ready) {
      this.logger.warn({ query, mode: opts.mode }, "search index not yet ready; returning empty result");
      return [];
    }
    const mode: SearchMode = opts.mode ?? "bm25";
    const limit = opts.limit ?? 20;
    const minScore = opts.minScore ?? 0;

    // Sync path can only honour BM25 — vector/hybrid require an async
    // embedding round-trip on the query. Callers asking for those modes
    // should use `searchAsync()`. We don't throw, because some legacy
    // call sites (e.g. lint preview) are wired through search() and we'd
    // rather degrade than crash.
    if (mode !== "bm25" && this.embeddingProvider.dimension > 0) {
      this.logger.debug({ query, mode }, "sync search() called with non-BM25 mode; use searchAsync — falling back to BM25");
    }
    return this.index.search(query, { limit, minScore });
  }

  /** Async entry point for "vector" / "hybrid" modes (which require
   *  awaiting the query embedding). Callers in async paths should prefer
   *  this; the sync `search()` covers the BM25-only fast path and falls
   *  through cleanly when an embedding-mode caller forgets and calls it. */
  async searchAsync(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    if (!this.ready) {
      this.logger.warn({ query, mode: opts.mode }, "search index not yet ready; returning empty result");
      return [];
    }
    const mode: SearchMode = opts.mode ?? "bm25";
    const limit = opts.limit ?? 20;
    const minScore = opts.minScore ?? 0;

    if (mode === "bm25" || this.embeddingProvider.dimension === 0) {
      return this.index.search(query, { limit, minScore });
    }

    let queryVec: Float32Array | null = null;
    try {
      queryVec = await this.embeddingProvider.embed(query);
    } catch (err) {
      this.logger.warn({ err, query }, "query embedding failed; falling back to BM25");
      return this.index.search(query, { limit, minScore });
    }
    if (!queryVec) {
      return this.index.search(query, { limit, minScore });
    }

    const vectorHits = this.vectorIndex.search(queryVec, { limit: Math.max(limit * 2, 50) });
    if (mode === "vector") return vectorHits.filter((h) => h.score >= minScore).slice(0, limit);

    // hybrid
    const bm25Hits = this.index.search(query, { limit: Math.max(limit * 2, 50) });
    const hybridOpts: HybridScoringOptions = { limit, minScore };
    if (typeof opts.hybridAlpha === "number") hybridOpts.alpha = opts.hybridAlpha;
    return combineHybrid(bm25Hits, vectorHits, hybridOpts);
  }

  /** Test / diagnostic accessor — number of indexed documents (BM25 side). */
  size(): number {
    return this.index.size();
  }

  /** Test / diagnostic accessor — number of vectors indexed. */
  vectorSize(): number {
    return this.vectorIndex.size();
  }

  /** Test / diagnostic accessor — true once init() has completed. */
  isReady(): boolean {
    return this.ready;
  }

  /** Test / diagnostic accessor — name of the active embedding provider. */
  embeddingModelName(): string {
    return this.embeddingProvider.name;
  }

  /** Test / diagnostic accessor — true when a real (non-null) provider is
   *  wired in and hybrid / vector search will produce useful results. */
  hasEmbeddingProvider(): boolean {
    return this.embeddingProvider.dimension > 0;
  }
}
