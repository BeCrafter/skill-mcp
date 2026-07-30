/**
 * P1-11 stage 2b — In-process BM25 keyword index over a small corpus of
 * skill rows. Designed for the < 10K-skill case where loading the full set
 * into RAM costs single-digit MB and avoids the pgvector / Postgres FTS
 * dependency that stage 3 will eventually layer on top.
 *
 * Tokenization is intentionally simple (lowercase + split on non-word) so
 * the same routine runs server-side and in lint-cmd previews; CJK and other
 * scripts fall through unchanged so a Chinese trigger phrase still indexes
 * as a single token rather than being silently dropped.
 *
 * Scoring uses the standard Okapi BM25 formula with k1=1.2, b=0.75:
 *
 *   score(q, d) = Σ_t∈q  idf(t) · tf · (k1+1) / (tf + k1·(1-b + b·|d|/avgdl))
 *   idf(t) = ln( (N - n(t) + 0.5) / (n(t) + 0.5) + 1 )
 *
 * The +1 inside the ln keeps idf non-negative even when a token appears in
 * every document (otherwise common words contribute negative score, which
 * surprises consumers more than it helps relevance).
 */

const K1 = 1.2;
const B = 0.75;

/** Lowercase and split on any non-word run; CJK etc. fall through. Empty
 *  strings filtered by the surrounding ternary. */
export function tokenize(input: string): string[] {
  if (!input) return [];
  return input.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 0);
}

interface Posting {
  /** raw term frequency in this document */
  tf: number;
}

interface DocStats {
  length: number;
  /** termId → tf (only populated when removing the doc) */
  terms: Map<string, number>;
}

export interface SearchHit {
  skillId: string;
  score: number;
}

export interface SearchOptions {
  /** Hard cap on returned hits (after sort). Defaults to 20. */
  limit?: number;
  /** Skip hits scoring below this threshold. Defaults to 0 (return everything). */
  minScore?: number;
  /** Optional caller-owned visibility candidate set, applied before ranking. */
  allowedSkillIds?: ReadonlySet<string>;
}

export class BM25Index {
  /** termId → (skillId → posting) */
  private postings = new Map<string, Map<string, Posting>>();
  private docs = new Map<string, DocStats>();
  private totalDocLength = 0;

  /** Number of documents currently indexed. */
  size(): number {
    return this.docs.size;
  }

  /** Index — or re-index — one document. Existing entry is replaced atomically. */
  upsert(skillId: string, text: string): void {
    if (this.docs.has(skillId)) {
      this.remove(skillId);
    }
    const tokens = tokenize(text);
    if (tokens.length === 0) {
      // Still record the doc so re-upserts don't blow up on empty text;
      // empty docs contribute zero to every query so the cost is one map entry.
      this.docs.set(skillId, { length: 0, terms: new Map() });
      return;
    }
    const terms = new Map<string, number>();
    for (const token of tokens) {
      terms.set(token, (terms.get(token) ?? 0) + 1);
    }
    for (const [token, tf] of terms) {
      let posting = this.postings.get(token);
      if (!posting) {
        posting = new Map();
        this.postings.set(token, posting);
      }
      posting.set(skillId, { tf });
    }
    this.docs.set(skillId, { length: tokens.length, terms });
    this.totalDocLength += tokens.length;
  }

  /** Remove a document from the index. No-op when the id is unknown. */
  remove(skillId: string): void {
    const doc = this.docs.get(skillId);
    if (!doc) return;
    for (const term of doc.terms.keys()) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      posting.delete(skillId);
      if (posting.size === 0) this.postings.delete(term);
    }
    this.totalDocLength -= doc.length;
    this.docs.delete(skillId);
  }

  /** Drop every entry. Used by SkillSearchService.rebuild(). */
  clear(): void {
    this.postings.clear();
    this.docs.clear();
    this.totalDocLength = 0;
  }

  /**
   * Score every document that shares at least one query term against the
   * query and return the top hits sorted by score descending.
   */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const limit = opts.limit ?? 20;
    const minScore = opts.minScore ?? 0;
    const allowedSkillIds = opts.allowedSkillIds;
    const tokens = tokenize(query);
    if (tokens.length === 0 || this.docs.size === 0) return [];

    const N = this.docs.size;
    const avgdl = this.totalDocLength / N;
    const scores = new Map<string, number>();

    // De-duplicate query terms — repeated tokens in the query don't help
    // BM25 (the formula is already a sum over query terms; duplicates would
    // double-count IDF).
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      const posting = this.postings.get(token);
      if (!posting) continue;
      const nT = posting.size;
      const idf = Math.log(((N - nT + 0.5) / (nT + 0.5)) + 1);
      for (const [skillId, { tf }] of posting) {
        if (allowedSkillIds && !allowedSkillIds.has(skillId)) continue;
        const doc = this.docs.get(skillId)!;
        const dl = doc.length;
        const norm = tf + K1 * (1 - B + (B * dl) / (avgdl || 1));
        const contribution = norm === 0 ? 0 : idf * (tf * (K1 + 1)) / norm;
        scores.set(skillId, (scores.get(skillId) ?? 0) + contribution);
      }
    }

    const hits: SearchHit[] = [];
    for (const [skillId, score] of scores) {
      if (score < minScore) continue;
      hits.push({ skillId, score });
    }
    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.skillId.localeCompare(b.skillId);
    });
    return hits.slice(0, limit);
  }
}

/**
 * Build the indexable text for one skill row. Separating this into its own
 * helper means both the indexer and the (forthcoming) `skill-search` REST
 * preview can compute the same string without duplicating field-precedence
 * logic. Joins fields with a single space — BM25 doesn't care about word
 * order, but tokenize() splits on whitespace anyway.
 *
 * Field weighting is implicit via repetition: name appears once, triggers
 * concatenated (each appearing once), description / whenToUse / embeddingText
 * each once. If a field needs to weigh more we'd repeat it (cheap and
 * doesn't change the formula).
 */
export function buildIndexText(input: {
  name: string;
  description?: string | null;
  retrievalMeta?: {
    triggers?: string[] | null;
    whenToUse?: string | null;
    embeddingText?: string | null;
  } | null;
}): string {
  const parts: string[] = [];
  if (input.name) parts.push(input.name);
  if (input.description) parts.push(input.description);
  const meta = input.retrievalMeta;
  if (meta?.triggers && Array.isArray(meta.triggers)) {
    for (const trigger of meta.triggers) {
      if (typeof trigger === "string" && trigger.length > 0) parts.push(trigger);
    }
  }
  if (meta?.whenToUse) parts.push(meta.whenToUse);
  if (meta?.embeddingText) parts.push(meta.embeddingText);
  return parts.join(" ");
}
