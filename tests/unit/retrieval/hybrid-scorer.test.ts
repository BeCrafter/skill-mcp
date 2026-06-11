import { describe, it, expect } from "vitest";
import { combineHybrid } from "@/retrieval/hybrid-scorer.js";
import type { SearchHit } from "@/retrieval/bm25-index.js";

/**
 * P1-11 stage 3 — hybrid scoring contract. Pins:
 *   - per-list min-max normalization so BM25 (unbounded) can't drown out
 *     cosine ([-1, 1])
 *   - α defaults to 0.5; values outside [0, 1] are clamped (typo > throw)
 *   - hits in only one list still rank, capped at the corresponding factor
 *   - span=0 (all scores equal, or single hit) → 1.0 not 0.0
 *   - tie tiebreak by skillId ascending
 *   - limit + minScore honored AFTER combining
 */

const hit = (skillId: string, score: number): SearchHit => ({ skillId, score });

describe("combineHybrid", () => {
  it("returns empty when both lists empty", () => {
    expect(combineHybrid([], [])).toEqual([]);
  });

  it("when only BM25 has hits, ranks by BM25 (vector contributes 0)", () => {
    const out = combineHybrid([hit("a", 10), hit("b", 5)], []);
    expect(out.map((h) => h.skillId)).toEqual(["a", "b"]);
    // a normalized to 1, vector side 0 → 0.5*1 = 0.5
    expect(out[0].score).toBeCloseTo(0.5, 4);
    expect(out[1].score).toBeCloseTo(0, 4);
  });

  it("when only vector has hits, ranks by vector (BM25 contributes 0)", () => {
    const out = combineHybrid([], [hit("a", 0.9), hit("b", 0.1)]);
    expect(out.map((h) => h.skillId)).toEqual(["a", "b"]);
    expect(out[0].score).toBeCloseTo(0.5, 4);
    expect(out[1].score).toBeCloseTo(0, 4);
  });

  it("default alpha=0.5 weights both signals equally", () => {
    // a is top of BM25 only; b is top of vector only; c is mid in both
    const bm25 = [hit("a", 10), hit("c", 5), hit("b", 1)];
    const vec = [hit("b", 0.9), hit("c", 0.5), hit("a", 0.1)];
    const out = combineHybrid(bm25, vec);
    // All three appear in both — c gets mid-mid, a gets high-low, b gets low-high.
    // a: 0.5*1 + 0.5*0 = 0.5 ; b: 0.5*0 + 0.5*1 = 0.5 ; c: 0.5*~0.44 + 0.5*~0.5 ≈ 0.47
    const map = new Map(out.map((h) => [h.skillId, h.score]));
    expect(map.get("a")).toBeCloseTo(0.5, 4);
    expect(map.get("b")).toBeCloseTo(0.5, 4);
    expect(map.get("c")!).toBeLessThan(0.5);
  });

  it("alpha=1 reduces to BM25-only ranking", () => {
    const out = combineHybrid(
      [hit("a", 10), hit("b", 5)],
      [hit("b", 0.9), hit("a", 0.1)],
      { alpha: 1 },
    );
    expect(out.map((h) => h.skillId)).toEqual(["a", "b"]);
    expect(out[0].score).toBeCloseTo(1, 4);
    expect(out[1].score).toBeCloseTo(0, 4);
  });

  it("alpha=0 reduces to vector-only ranking", () => {
    const out = combineHybrid(
      [hit("a", 10), hit("b", 5)],
      [hit("b", 0.9), hit("a", 0.1)],
      { alpha: 0 },
    );
    expect(out.map((h) => h.skillId)).toEqual(["b", "a"]);
    expect(out[0].score).toBeCloseTo(1, 4);
    expect(out[1].score).toBeCloseTo(0, 4);
  });

  it("alpha out of range is clamped (>1 → 1, <0 → 0)", () => {
    const bm25 = [hit("a", 10), hit("b", 5)];
    const vec = [hit("b", 0.9), hit("a", 0.1)];

    const tooHigh = combineHybrid(bm25, vec, { alpha: 99 });
    expect(tooHigh.map((h) => h.skillId)).toEqual(["a", "b"]);

    const tooLow = combineHybrid(bm25, vec, { alpha: -5 });
    expect(tooLow.map((h) => h.skillId)).toEqual(["b", "a"]);
  });

  it("span=0 (all BM25 scores equal) normalizes every hit to 1", () => {
    // Three BM25 hits all at the same score; no vector signal.
    // Each should normalize to 1 → combined = 0.5*1 + 0.5*0 = 0.5.
    const out = combineHybrid(
      [hit("a", 7), hit("b", 7), hit("c", 7)],
      [],
    );
    for (const h of out) {
      expect(h.score).toBeCloseTo(0.5, 4);
    }
    expect(out.length).toBe(3);
  });

  it("single-hit list normalizes that hit to 1.0", () => {
    const out = combineHybrid([hit("a", 42)], [], { alpha: 1 });
    expect(out.length).toBe(1);
    expect(out[0].score).toBeCloseTo(1, 4);
  });

  it("union of ids — present in only one list still ranks", () => {
    const out = combineHybrid([hit("a", 10)], [hit("b", 0.9)]);
    expect(new Set(out.map((h) => h.skillId))).toEqual(new Set(["a", "b"]));
  });

  it("respects limit", () => {
    const bm25 = [hit("a", 10), hit("b", 8), hit("c", 6), hit("d", 4)];
    const out = combineHybrid(bm25, [], { limit: 2 });
    expect(out.length).toBe(2);
    expect(out.map((h) => h.skillId)).toEqual(["a", "b"]);
  });

  it("respects minScore (filter applied AFTER combining)", () => {
    // alpha=1, BM25 only. a normalizes to 1, b to 0. minScore 0.6 keeps only a.
    const out = combineHybrid(
      [hit("a", 10), hit("b", 5)],
      [],
      { alpha: 1, minScore: 0.6 },
    );
    expect(out.map((h) => h.skillId)).toEqual(["a"]);
  });

  it("ties on combined score break by skillId ascending", () => {
    // Two hits with equal raw BM25 → both normalize to 1 → both combined 0.5.
    const out = combineHybrid(
      [hit("zebra", 5), hit("alpha", 5)],
      [],
    );
    expect(out.map((h) => h.skillId)).toEqual(["alpha", "zebra"]);
  });

  it("default limit is 20", () => {
    const bm25: SearchHit[] = [];
    for (let i = 0; i < 30; i += 1) {
      bm25.push(hit(`s${String(i).padStart(2, "0")}`, 30 - i));
    }
    const out = combineHybrid(bm25, []);
    expect(out.length).toBe(20);
  });
});
