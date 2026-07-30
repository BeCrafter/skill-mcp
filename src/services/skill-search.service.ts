import type { Logger } from "pino";
import type { SkillRepository } from "../db/repositories/skill.repository.js";
import type { DomainEventBus } from "../events/event-bus.js";
import { BM25Index, buildIndexText, type SearchHit } from "../retrieval/bm25-index.js";

/** Options for the in-process BM25 skill index. */
export interface SearchOptions {
  limit?: number;
  minScore?: number;
  /** Restrict scoring to already-authorized skill IDs. Never expose this at a public boundary. */
  allowedSkillIds?: ReadonlySet<string>;
}

/**
 * Owns the lifecycle of the in-process BM25 index. The corpus is hydrated
 * before the server starts and converges incrementally after skill mutations.
 *
 * Retrieval is intentionally keyword-only in v0.1: no embedding provider,
 * vector database, remote request, or hybrid fallback is present in this
 * runtime path. `retrieval_meta.embedding_text` remains input text for BM25.
 */
export class SkillSearchService {
  private readonly index = new BM25Index();
  private readonly slugToId = new Map<string, string>();
  private ready = false;
  private rebuildInflight: Promise<void> | null = null;

  constructor(
    private readonly skillRepo: SkillRepository,
    private readonly logger: Logger,
  ) {}

  /** Hydrate the complete corpus. A failed initial build rejects startup. */
  async init(): Promise<void> {
    if (this.ready) return;
    if (this.rebuildInflight) return this.rebuildInflight;
    this.rebuildInflight = this.rebuild();
    try {
      await this.rebuildInflight;
      this.ready = true;
    } finally {
      this.rebuildInflight = null;
    }
  }

  /** Replace the corpus with every locally persisted skill. */
  async rebuild(): Promise<void> {
    const skills = await this.skillRepo.findAll();
    this.index.clear();
    this.slugToId.clear();
    for (const skill of skills) {
      this.index.upsert(skill.id, buildIndexText(skill));
      this.slugToId.set(skill.slug, skill.id);
    }
    this.logger.info({ count: skills.length }, "BM25 search index rebuilt");
  }

  /** Re-index a skill after an import or metadata/content update. */
  async refreshOne(slug: string): Promise<void> {
    const skill = await this.skillRepo.findBySlug(slug);
    if (!skill) {
      this.removeBySlug(slug);
      return;
    }
    this.index.upsert(skill.id, buildIndexText(skill));
    this.slugToId.set(skill.slug, skill.id);
  }

  /** Remove a deleted skill by its stable slug. */
  removeBySlug(slug: string): void {
    const id = this.slugToId.get(slug);
    if (!id) return;
    this.index.remove(id);
    this.slugToId.delete(slug);
  }

  /** Subscribe for background convergence; direct mutation paths may also await refreshOne. */
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
    bus.on("skill:deleted", (event) => this.removeBySlug(event.slug));
  }

  /** Run a permission-aware BM25 query. */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    if (!this.ready) {
      this.logger.warn({ query }, "BM25 search requested before index initialization");
      return [];
    }
    return this.index.search(query, {
      limit: opts.limit,
      minScore: opts.minScore,
      allowedSkillIds: opts.allowedSkillIds,
    });
  }

  size(): number {
    return this.index.size();
  }

  isReady(): boolean {
    return this.ready;
  }
}
