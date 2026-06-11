/**
 * P1-11 stage 3 — combine BM25 keyword hits with cosine-similarity vector
 * hits into a single ranked list.
 *
 * Approach:
 *  1. Collect the union of skill ids that appeared in either list.
 *  2. Min-max normalize each list to [0, 1] independently. Normalizing
 *     each list separately (rather than e.g. forcing a global scale) lets
 *     us combine scores that live on incompatible ranges (BM25 is
 *     unbounded above, cosine is in [-1, 1]) without one signal dominating
 *     just because of its native magnitude.
 *  3. Linear combination `α · bm25_norm + (1 - α) · vector_norm` per id,
 *     where α defaults to 0.5 so neither signal is privileged out of the
 *     box. Operators tune α via config / admin REST when their corpus
 *     leans heavier toward keyword or semantic matching.
 *
 * Edge cases:
 *  - One list empty → behave like the other list alone (so a vector-only
 *    or BM25-only deployment still ranks sensibly without a special path).
 *  - List has one hit → that hit normalizes to 1; missing-from-other-list
 *    contributes 0 from that side — we don't synthesise a score we don't
 *    have. The downside is that a hit which appears in only one signal is
 *    capped at the corresponding α/(1-α) factor; that matches the intent
 *    ("hybrid hit > single-signal hit").
 *  - α outside [0, 1] is clamped — out-of-range alpha is almost always a
 *    config typo and we'd rather rank than throw.
 */

import type { SearchHit } from "./bm25-index.js";

export interface HybridScoringOptions {
  /** Weight on the BM25 component. Range [0, 1]; clamped if outside.
   *  α=1 → BM25 only; α=0 → vector only. Default 0.5. */
  alpha?: number;
  /** Hard cap on returned hits after combining. Default 20. */
  limit?: number;
  /** Drop hits whose combined score is below this. Default 0. */
  minScore?: number;
}

/**
 * Min-max normalize an array of hits to [0, 1] in place over a copy. When
 * all hits share the same score (or there's only one), every hit
 * normalizes to 1 — this matches the intent that they're all equally
 * "best of what we have" rather than collapsing to 0.
 */
function normalize(hits: SearchHit[]): Map<string, number> {
  const out = new Map<string, number>();
  if (hits.length === 0) return out;
  let min = Infinity;
  let max = -Infinity;
  for (const h of hits) {
    if (h.score < min) min = h.score;
    if (h.score > max) max = h.score;
  }
  const span = max - min;
  for (const h of hits) {
    out.set(h.skillId, span === 0 ? 1 : (h.score - min) / span);
  }
  return out;
}

export function combineHybrid(
  bm25Hits: SearchHit[],
  vectorHits: SearchHit[],
  opts: HybridScoringOptions = {},
): SearchHit[] {
  const limit = opts.limit ?? 20;
  const minScore = opts.minScore ?? 0;
  const alpha = Math.min(1, Math.max(0, opts.alpha ?? 0.5));

  const bm25Norm = normalize(bm25Hits);
  const vecNorm = normalize(vectorHits);

  const allIds = new Set<string>();
  for (const h of bm25Hits) allIds.add(h.skillId);
  for (const h of vectorHits) allIds.add(h.skillId);

  const combined: SearchHit[] = [];
  for (const id of allIds) {
    const b = bm25Norm.get(id) ?? 0;
    const v = vecNorm.get(id) ?? 0;
    const score = alpha * b + (1 - alpha) * v;
    if (score < minScore) continue;
    combined.push({ skillId: id, score });
  }

  combined.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.skillId.localeCompare(b.skillId);
  });
  return combined.slice(0, limit);
}
