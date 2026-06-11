import { describe, it, expect } from "vitest";
import { VectorIndex } from "@/retrieval/vector-index.js";

/**
 * P1-11 stage 3 — VectorIndex contract. Pins:
 *   - upsert pins dimension on first call; mismatch raises
 *   - non-normalized vectors are rejected at upsert AND query time so
 *     consumers can't poison cosine math
 *   - search uses dot product (= cosine for normalized inputs) and sorts
 *     by score descending with a stable tiebreak on skillId
 *   - remove + clear are clean no-ops on missing keys
 */

function unit(values: number[]): Float32Array {
  const v = new Float32Array(values);
  let n = 0;
  for (let i = 0; i < v.length; i += 1) n += v[i] * v[i];
  n = Math.sqrt(n);
  for (let i = 0; i < v.length; i += 1) v[i] /= n;
  return v;
}

describe("VectorIndex", () => {
  describe("dimension management", () => {
    it("size and dim start at 0", () => {
      const idx = new VectorIndex();
      expect(idx.size()).toBe(0);
      expect(idx.dim()).toBe(0);
    });

    it("first upsert pins the dimension", () => {
      const idx = new VectorIndex();
      idx.upsert("a", unit([1, 0, 0]));
      expect(idx.dim()).toBe(3);
      expect(idx.size()).toBe(1);
    });

    it("upsert with mismatched dimension raises", () => {
      const idx = new VectorIndex();
      idx.upsert("a", unit([1, 0, 0]));
      expect(() => idx.upsert("b", unit([1, 0, 0, 0]))).toThrow(/dimension mismatch/);
    });
  });

  describe("normalization guard", () => {
    it("rejects unnormalized vector on upsert", () => {
      const idx = new VectorIndex();
      const v = new Float32Array([2, 0, 0]); // |v| = 2
      expect(() => idx.upsert("a", v)).toThrow(/not L2-normalized/);
    });

    it("rejects unnormalized query vector on search", () => {
      const idx = new VectorIndex();
      idx.upsert("a", unit([1, 0, 0]));
      const bad = new Float32Array([3, 0, 0]);
      expect(() => idx.search(bad)).toThrow(/not L2-normalized/);
    });
  });

  describe("search", () => {
    it("ranks by cosine similarity descending", () => {
      const idx = new VectorIndex();
      idx.upsert("a", unit([1, 0, 0]));   // identical to query
      idx.upsert("b", unit([1, 1, 0]));   // 0.707
      idx.upsert("c", unit([0, 1, 0]));   // 0
      const hits = idx.search(unit([1, 0, 0]));
      expect(hits.map((h) => h.skillId)).toEqual(["a", "b", "c"]);
      expect(hits[0].score).toBeCloseTo(1, 4);
      expect(hits[1].score).toBeCloseTo(1 / Math.sqrt(2), 4);
      expect(hits[2].score).toBeCloseTo(0, 4);
    });

    it("respects limit", () => {
      const idx = new VectorIndex();
      idx.upsert("a", unit([1, 0]));
      idx.upsert("b", unit([1, 0.1]));
      idx.upsert("c", unit([1, 0.2]));
      const hits = idx.search(unit([1, 0]), { limit: 2 });
      expect(hits.length).toBe(2);
    });

    it("respects minScore", () => {
      const idx = new VectorIndex();
      idx.upsert("a", unit([1, 0]));   // sim ≈ 1
      idx.upsert("b", unit([0, 1]));   // sim ≈ 0
      const hits = idx.search(unit([1, 0]), { minScore: 0.5 });
      expect(hits.map((h) => h.skillId)).toEqual(["a"]);
    });

    it("returns empty when index is empty", () => {
      const idx = new VectorIndex();
      // Query before any upsert — no dim pinned yet so we can't even build
      // a query vector. Empty result is the right answer.
      expect(idx.size()).toBe(0);
      expect(idx.search(unit([1, 0]))).toEqual([]);
    });

    it("ties on score break by skillId ascending (stable order)", () => {
      const idx = new VectorIndex();
      idx.upsert("zebra", unit([1, 0]));
      idx.upsert("alpha", unit([1, 0]));
      idx.upsert("middle", unit([1, 0]));
      const hits = idx.search(unit([1, 0]));
      expect(hits.map((h) => h.skillId)).toEqual(["alpha", "middle", "zebra"]);
    });

    it("query dimension mismatch raises", () => {
      const idx = new VectorIndex();
      idx.upsert("a", unit([1, 0, 0]));
      expect(() => idx.search(unit([1, 0]))).toThrow(/dimension/);
    });
  });

  describe("upsert / remove / clear", () => {
    it("upsert replaces existing vector", () => {
      const idx = new VectorIndex();
      idx.upsert("a", unit([1, 0, 0]));
      idx.upsert("a", unit([0, 1, 0]));
      expect(idx.size()).toBe(1);
      const hits = idx.search(unit([0, 1, 0]));
      expect(hits[0].skillId).toBe("a");
      expect(hits[0].score).toBeCloseTo(1, 4);
    });

    it("remove drops an entry", () => {
      const idx = new VectorIndex();
      idx.upsert("a", unit([1, 0]));
      idx.upsert("b", unit([0, 1]));
      idx.remove("a");
      expect(idx.size()).toBe(1);
      const hits = idx.search(unit([1, 0]));
      expect(hits.map((h) => h.skillId)).toEqual(["b"]);
    });

    it("remove on unknown id is a no-op", () => {
      const idx = new VectorIndex();
      idx.upsert("a", unit([1, 0]));
      idx.remove("nope");
      expect(idx.size()).toBe(1);
    });

    it("clear empties the index AND resets the dimension", () => {
      const idx = new VectorIndex();
      idx.upsert("a", unit([1, 0]));
      idx.clear();
      expect(idx.size()).toBe(0);
      expect(idx.dim()).toBe(0);
      // After clear, the dimension is unpinned — a different-dim upsert is OK.
      idx.upsert("a", unit([1, 0, 0]));
      expect(idx.dim()).toBe(3);
    });
  });
});
