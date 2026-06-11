/**
 * P1-11 stage 3 — in-memory cosine-similarity index over L2-normalized
 * vectors. Mirrors the BM25Index API surface (`upsert` / `remove` / `clear` /
 * `search` / `size`) so the hybrid scoring layer and SkillSearchService can
 * treat the two indexes uniformly.
 *
 * Design notes:
 *  - Vectors arriving here MUST be L2-normalized — the IEmbeddingProvider
 *    contract guarantees this. We assert |v| ∈ [1-ε, 1+ε] on upsert and
 *    raise rather than silently distorting cosine math. (A bad provider
 *    would otherwise float through to query time and look like ranking bugs.)
 *  - search() returns the standard `{skillId, score}[]` shape so the hybrid
 *    layer can mix it with BM25 results without translation.
 *  - All vectors must share the same dimension. The first upsert pins it;
 *    subsequent upserts that disagree raise. A model swap is therefore an
 *    explicit `clear()`-and-reload event rather than an undefined-behaviour
 *    accumulation of mixed-dim vectors.
 */

import type { SearchHit } from "./bm25-index.js";

const NORM_EPSILON = 1e-3;

export interface VectorSearchOptions {
  /** Hard cap on returned hits (after sort). Defaults to 20. */
  limit?: number;
  /** Skip hits scoring below this threshold. Defaults to -1 (return everything;
   *  cosine ranges over [-1, 1]). */
  minScore?: number;
}

export class VectorIndex {
  private vectors = new Map<string, Float32Array>();
  private dimension = 0;

  /** Number of vectors currently indexed. */
  size(): number {
    return this.vectors.size;
  }

  /** Vector dimension pinned by the first upsert; 0 before any upsert. */
  dim(): number {
    return this.dimension;
  }

  /** Index — or re-index — one vector. The vector MUST be L2-normalized;
   *  upserting a non-normalized vector raises so consumers can't silently
   *  poison ranking. */
  upsert(skillId: string, vector: Float32Array): void {
    if (this.dimension === 0) {
      this.dimension = vector.length;
    } else if (vector.length !== this.dimension) {
      throw new Error(
        `VectorIndex: dimension mismatch (got ${vector.length}, expected ${this.dimension})`,
      );
    }
    let normSq = 0;
    for (let i = 0; i < vector.length; i += 1) normSq += vector[i] * vector[i];
    const norm = Math.sqrt(normSq);
    if (Math.abs(norm - 1) > NORM_EPSILON) {
      throw new Error(`VectorIndex: vector is not L2-normalized (|v|=${norm.toFixed(4)})`);
    }
    this.vectors.set(skillId, vector);
  }

  /** Remove a vector from the index. No-op when the id is unknown. */
  remove(skillId: string): void {
    this.vectors.delete(skillId);
  }

  /** Drop every entry. Used by SkillSearchService.rebuild() and by the
   *  model-swap path. */
  clear(): void {
    this.vectors.clear();
    this.dimension = 0;
  }

  /**
   * Score every indexed vector against the query and return the top hits
   * sorted by similarity descending. Cosine sim simplifies to a plain dot
   * product because both query and index vectors are L2-normalized.
   *
   * The query vector MUST be L2-normalized and dimension-matched. Mismatch
   * raises rather than returning garbage scores.
   */
  search(query: Float32Array, opts: VectorSearchOptions = {}): SearchHit[] {
    const limit = opts.limit ?? 20;
    const minScore = opts.minScore ?? -1;
    if (this.vectors.size === 0) return [];
    if (query.length !== this.dimension) {
      throw new Error(
        `VectorIndex: query dimension ${query.length} does not match index ${this.dimension}`,
      );
    }
    let queryNormSq = 0;
    for (let i = 0; i < query.length; i += 1) queryNormSq += query[i] * query[i];
    const queryNorm = Math.sqrt(queryNormSq);
    if (Math.abs(queryNorm - 1) > NORM_EPSILON) {
      throw new Error(`VectorIndex: query vector is not L2-normalized (|q|=${queryNorm.toFixed(4)})`);
    }

    const hits: SearchHit[] = [];
    for (const [skillId, v] of this.vectors) {
      let dot = 0;
      for (let i = 0; i < v.length; i += 1) dot += v[i] * query[i];
      if (dot < minScore) continue;
      hits.push({ skillId, score: dot });
    }
    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.skillId.localeCompare(b.skillId);
    });
    return hits.slice(0, limit);
  }
}
