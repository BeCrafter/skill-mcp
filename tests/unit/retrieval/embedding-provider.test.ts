import { describe, it, expect } from "vitest";
import { NullEmbeddingProvider, HashEmbeddingProvider } from "@/retrieval/embedding-provider.js";

/**
 * P1-11 stage 3 — embedding provider contract. Pins:
 *   - NullEmbeddingProvider returns null + dimension=0 (signals "skip
 *     vector path") so deployments without an embedding model are safe.
 *   - HashEmbeddingProvider is deterministic (same input → same vector),
 *     produces L2-normalized output, dimension is configurable, and
 *     short-circuits on empty / whitespace input the same way real
 *     providers would.
 */
describe("NullEmbeddingProvider", () => {
  it("has zero dimension and a stable name", () => {
    const p = new NullEmbeddingProvider();
    expect(p.dimension).toBe(0);
    expect(p.name).toBe("null");
  });

  it("returns null for any input", async () => {
    const p = new NullEmbeddingProvider();
    expect(await p.embed("anything")).toBeNull();
    expect(await p.embed("")).toBeNull();
  });

  it("returns one null per input in batch", async () => {
    const p = new NullEmbeddingProvider();
    const out = await p.embedBatch(["a", "b", "c"]);
    expect(out).toEqual([null, null, null]);
  });
});

describe("HashEmbeddingProvider", () => {
  it("uses default 384 dimension and 'hash-stub' name", () => {
    const p = new HashEmbeddingProvider();
    expect(p.dimension).toBe(384);
    expect(p.name).toBe("hash-stub");
  });

  it("accepts custom name and dimension", () => {
    const p = new HashEmbeddingProvider({ name: "test-512", dimension: 512 });
    expect(p.dimension).toBe(512);
    expect(p.name).toBe("test-512");
  });

  it("rejects out-of-range dimension", () => {
    expect(() => new HashEmbeddingProvider({ dimension: 4 })).toThrow();
    expect(() => new HashEmbeddingProvider({ dimension: 8192 })).toThrow();
  });

  it("returns null for empty / whitespace / non-tokenizable input", async () => {
    const p = new HashEmbeddingProvider();
    expect(await p.embed("")).toBeNull();
    expect(await p.embed("   ")).toBeNull();
    expect(await p.embed("!!!")).toBeNull();
  });

  it("produces a vector of the correct dimension", async () => {
    const p = new HashEmbeddingProvider({ dimension: 64 });
    const v = await p.embed("hello world");
    expect(v).not.toBeNull();
    expect(v!.length).toBe(64);
  });

  it("output is L2-normalized (|v| ≈ 1)", async () => {
    const p = new HashEmbeddingProvider();
    const v = await p.embed("ripgrep helper for searching directories");
    expect(v).not.toBeNull();
    let normSq = 0;
    for (let i = 0; i < v!.length; i += 1) normSq += v![i] * v![i];
    expect(Math.sqrt(normSq)).toBeCloseTo(1, 3);
  });

  it("is deterministic — same input always produces the same vector", async () => {
    const p = new HashEmbeddingProvider();
    const a = await p.embed("the quick brown fox");
    const b = await p.embed("the quick brown fox");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    for (let i = 0; i < a!.length; i += 1) {
      expect(a![i]).toBe(b![i]);
    }
  });

  it("different inputs produce different vectors", async () => {
    const p = new HashEmbeddingProvider();
    const a = await p.embed("ripgrep");
    const b = await p.embed("postgresql");
    let same = true;
    for (let i = 0; i < a!.length; i += 1) {
      if (a![i] !== b![i]) { same = false; break; }
    }
    expect(same).toBe(false);
  });

  it("token-overlapping inputs are more similar than disjoint ones", async () => {
    const p = new HashEmbeddingProvider();
    const a = await p.embed("ripgrep search directory");
    const b = await p.embed("ripgrep search files");
    const c = await p.embed("postgresql database backup");
    // dot product (cosine, since normalized)
    const dot = (x: Float32Array, y: Float32Array) => {
      let s = 0;
      for (let i = 0; i < x.length; i += 1) s += x[i] * y[i];
      return s;
    };
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
  });

  it("embedBatch returns one slot per input in input order", async () => {
    const p = new HashEmbeddingProvider();
    const out = await p.embedBatch(["alpha", "", "beta"]);
    expect(out.length).toBe(3);
    expect(out[0]).not.toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).not.toBeNull();
  });
});
