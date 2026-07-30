import { describe, it, expect } from "vitest";
import { BM25Index, buildIndexText, tokenize } from "../../../src/retrieval/bm25-index.js";

/**
 * P1-11 stage 2b — BM25 indexer correctness suite. Each test pins a property
 * we rely on at the SkillSearchService / `skill_search` layer:
 *   - tokenization preserves CJK and ignores case
 *   - upsert is idempotent and replaces stale postings
 *   - remove drops the doc from every term posting
 *   - score ordering reflects term frequency + idf, not insertion order
 */

describe("tokenize", () => {
  it("lowercases and splits on non-word", () => {
    expect(tokenize("Search File Tree")).toEqual(["search", "file", "tree"]);
  });

  it("preserves CJK as single tokens", () => {
    expect(tokenize("查找代码 grep")).toEqual(["查找代码", "grep"]);
  });

  it("returns empty for empty / whitespace input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("splits on punctuation", () => {
    expect(tokenize("foo,bar.baz!qux?")).toEqual(["foo", "bar", "baz", "qux"]);
  });
});

describe("BM25Index", () => {
  it("ranks document with higher term frequency above one with a single mention", () => {
    const idx = new BM25Index();
    idx.upsert("a", "ripgrep ripgrep ripgrep search files");
    idx.upsert("b", "search files for a needle");
    const hits = idx.search("ripgrep");
    expect(hits[0].skillId).toBe("a");
    expect(hits.find(h => h.skillId === "b")).toBeUndefined();
  });

  it("returns empty result for empty query and unknown terms", () => {
    const idx = new BM25Index();
    idx.upsert("a", "alpha beta");
    expect(idx.search("")).toEqual([]);
    expect(idx.search("zeta")).toEqual([]);
  });

  it("upsert replaces stale text — old terms no longer match", () => {
    const idx = new BM25Index();
    idx.upsert("a", "search files");
    expect(idx.search("search").length).toBe(1);
    idx.upsert("a", "totally different content");
    expect(idx.search("search")).toEqual([]);
    expect(idx.search("totally").length).toBe(1);
  });

  it("remove drops the document from every posting", () => {
    const idx = new BM25Index();
    idx.upsert("a", "alpha beta");
    idx.upsert("b", "alpha gamma");
    expect(idx.search("alpha").map(h => h.skillId).sort()).toEqual(["a", "b"]);
    idx.remove("a");
    expect(idx.search("alpha").map(h => h.skillId)).toEqual(["b"]);
    expect(idx.size()).toBe(1);
  });

  it("clear empties the index", () => {
    const idx = new BM25Index();
    idx.upsert("a", "alpha");
    idx.upsert("b", "beta");
    idx.clear();
    expect(idx.size()).toBe(0);
    expect(idx.search("alpha")).toEqual([]);
  });

  it("limit caps the returned hits", () => {
    const idx = new BM25Index();
    for (let i = 0; i < 10; i++) idx.upsert(`s${i}`, "common term");
    const hits = idx.search("common", { limit: 3 });
    expect(hits).toHaveLength(3);
  });

  it("filters to authorized candidates before applying the result limit", () => {
    const idx = new BM25Index();
    idx.upsert("private-high", "needle needle needle needle");
    idx.upsert("public-low", "needle");
    const hits = idx.search("needle", { limit: 1, allowedSkillIds: new Set(["public-low"]) });
    expect(hits).toEqual([expect.objectContaining({ skillId: "public-low" })]);
  });

  it("ties broken deterministically by skillId ascending", () => {
    const idx = new BM25Index();
    idx.upsert("zeta", "alpha");
    idx.upsert("alpha", "alpha");
    idx.upsert("mike", "alpha");
    const hits = idx.search("alpha");
    expect(hits.map(h => h.skillId)).toEqual(["alpha", "mike", "zeta"]);
  });

  it("multiple query tokens accumulate score across matches", () => {
    const idx = new BM25Index();
    idx.upsert("a", "search files recursively");
    idx.upsert("b", "search content");
    idx.upsert("c", "files only");
    const hits = idx.search("search files");
    // 'a' matches both terms; 'b' and 'c' only one each.
    expect(hits[0].skillId).toBe("a");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("idempotent upsert does not double-count the same doc", () => {
    const idx = new BM25Index();
    idx.upsert("a", "alpha alpha alpha");
    const score1 = idx.search("alpha")[0].score;
    idx.upsert("a", "alpha alpha alpha");
    const score2 = idx.search("alpha")[0].score;
    expect(score2).toBeCloseTo(score1, 5);
    expect(idx.size()).toBe(1);
  });
});

describe("buildIndexText", () => {
  it("concatenates name + description + triggers + whenToUse + embeddingText", () => {
    const text = buildIndexText({
      name: "ripgrep",
      description: "Search files",
      retrievalMeta: {
        triggers: ["find regex", "grep recursively"],
        whenToUse: "When user wants pattern search",
        embeddingText: "fast recursive grep",
      },
    });
    expect(text).toContain("ripgrep");
    expect(text).toContain("Search files");
    expect(text).toContain("find regex");
    expect(text).toContain("grep recursively");
    expect(text).toContain("When user wants pattern search");
    expect(text).toContain("fast recursive grep");
  });

  it("tolerates null retrievalMeta and empty triggers", () => {
    expect(buildIndexText({ name: "a", description: "b", retrievalMeta: null })).toBe("a b");
    expect(buildIndexText({ name: "a", description: null, retrievalMeta: { triggers: [] } })).toBe("a");
  });

  it("filters non-string triggers defensively", () => {
    const text = buildIndexText({
      name: "demo",
      retrievalMeta: { triggers: ["valid", 123 as unknown as string, "", "also-valid"] },
    });
    expect(text).toBe("demo valid also-valid");
  });
});
