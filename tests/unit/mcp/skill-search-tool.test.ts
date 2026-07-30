import { describe, it, expect, vi } from "vitest";
import { createSkillSearchTool } from "../../../src/mcp/tools/skill-search.js";
import type { SkillService } from "../../../src/services/skill.service.js";

/**
 * P1-11 stage 2b — `skill_search` MCP tool contract: schema accepts the
 * `{query, limit?, tags?}` shape, the handler delegates to
 * `searchAccessibleSkills`, formats hits with three-decimal scores and a
 * truncated description, and emits a fallback message on empty results.
 */

const HIT = (slug: string, id = slug, description = `desc for ${slug}`, score = 1) => ({
  skill: {
    id,
    slug,
    name: slug,
    displayName: null,
    description,
    version: "0.0.1",
    category: null,
    tags: [],
    attributes: {},
    status: "published" as const,
    visibility: "public" as const,
    entryFile: "SKILL.md",
    storagePath: `${slug}/`,
    contentHash: "h",
    createdAt: 1,
    updatedAt: 1,
    retrievalMeta: null,
  },
  score,
});

function fakeService(hits: ReturnType<typeof HIT>[] = []): SkillService {
  return {
    searchAccessibleSkills: vi.fn().mockResolvedValue(hits),
  } as unknown as SkillService;
}

describe("skill_search MCP tool", () => {
  describe("schema", () => {
    it("accepts { query }", () => {
      const tool = createSkillSearchTool(fakeService());
      expect(tool.inputSchema.parse({ query: "ripgrep" })).toMatchObject({ query: "ripgrep" });
    });

    it("accepts { query, limit, tags }", () => {
      const tool = createSkillSearchTool(fakeService());
      const parsed = tool.inputSchema.parse({ query: "x", limit: 5, tags: ["dev"] });
      expect(parsed).toMatchObject({ query: "x", limit: 5, tags: ["dev"] });
    });

    it("rejects empty query", () => {
      const tool = createSkillSearchTool(fakeService());
      expect(() => tool.inputSchema.parse({ query: "" })).toThrow();
    });

    it("rejects query longer than 512 chars", () => {
      const tool = createSkillSearchTool(fakeService());
      expect(() => tool.inputSchema.parse({ query: "x".repeat(513) })).toThrow();
    });

    it("rejects limit > 50", () => {
      const tool = createSkillSearchTool(fakeService());
      expect(() => tool.inputSchema.parse({ query: "x", limit: 51 })).toThrow();
    });

    it("rejects limit < 1", () => {
      const tool = createSkillSearchTool(fakeService());
      expect(() => tool.inputSchema.parse({ query: "x", limit: 0 })).toThrow();
    });

    it("rejects non-integer limit", () => {
      const tool = createSkillSearchTool(fakeService());
      expect(() => tool.inputSchema.parse({ query: "x", limit: 1.5 })).toThrow();
    });
  });

  describe("handler", () => {
    it("formats hits with score and description", async () => {
      const hits = [
        HIT("alpha", "id-a", "an alpha skill", 5.123),
        HIT("beta", "id-b", "the beta skill", 1.5),
      ];
      const tool = createSkillSearchTool(fakeService(hits));
      const result = await tool.handler({ query: "ripgrep" });
      const text = result.content[0].text;
      expect(text).toContain("Skill Search Results");
      expect(text).toContain("query: ripgrep");
      expect(text).toContain("- alpha [id:id-a] (score=5.123): an alpha skill");
      expect(text).toContain("- beta [id:id-b] (score=1.500): the beta skill");
    });

    it("truncates descriptions over 80 chars", async () => {
      const longDesc = "x".repeat(120);
      const tool = createSkillSearchTool(fakeService([HIT("a", "id-a", longDesc, 1)]));
      const result = await tool.handler({ query: "x" });
      expect(result.content[0].text).toContain("...");
      expect(result.content[0].text).not.toContain("x".repeat(120));
    });

    it("emits the empty-result fallback message", async () => {
      const tool = createSkillSearchTool(fakeService([]));
      const result = await tool.handler({ query: "no-match" });
      expect(result.content[0].text).toContain("No matching skills found");
      expect(result.content[0].text).toContain("query: no-match");
    });

    it("forwards limit to searchAccessibleSkills", async () => {
      const svc = fakeService([HIT("a", "id-a")]);
      const tool = createSkillSearchTool(svc);
      await tool.handler({ query: "x", limit: 3 });
      expect((svc.searchAccessibleSkills as unknown as ReturnType<typeof vi.fn>))
        .toHaveBeenCalledWith(undefined, "x", expect.objectContaining({ limit: 3 }));
    });

    it("defaults limit to 10 when omitted", async () => {
      const svc = fakeService([]);
      const tool = createSkillSearchTool(svc);
      await tool.handler({ query: "x" });
      expect((svc.searchAccessibleSkills as unknown as ReturnType<typeof vi.fn>))
        .toHaveBeenCalledWith(undefined, "x", expect.objectContaining({ limit: 10 }));
    });

    it("forwards tags filter", async () => {
      const svc = fakeService([]);
      const tool = createSkillSearchTool(svc);
      await tool.handler({ query: "x", tags: ["dev"] });
      expect((svc.searchAccessibleSkills as unknown as ReturnType<typeof vi.fn>))
        .toHaveBeenCalledWith(undefined, "x", expect.objectContaining({ tags: ["dev"] }));
    });

    it("invokes contextBuilder with extra when provided", async () => {
      const svc = fakeService([]);
      const ctx = { userId: "u", sessionId: "s", tags: new Set<string>(), isAuthenticated: true };
      const contextBuilder = vi.fn().mockResolvedValue(ctx);
      const tool = createSkillSearchTool(svc, contextBuilder);
      const fakeExtra = { requestInfo: { headers: {} } } as never;
      await tool.handler({ query: "x" }, fakeExtra);
      expect(contextBuilder).toHaveBeenCalledWith(fakeExtra);
      expect((svc.searchAccessibleSkills as unknown as ReturnType<typeof vi.fn>))
        .toHaveBeenCalledWith(ctx, "x", expect.any(Object));
    });
  });

  /**
   * P1-11 stage 3 — mode + hybridAlpha plumbing. Pins:
   *   - schema accepts the three modes and clamps alpha to [0, 1]
   *   - mode + hybridAlpha forward verbatim to searchAccessibleSkills
   *   - mode is omitted (undefined → service applies its own default)
   */
  describe("stage 3 — mode and hybridAlpha", () => {
    it("schema accepts mode='bm25', 'vector', and 'hybrid'", () => {
      const tool = createSkillSearchTool(fakeService());
      expect(tool.inputSchema.parse({ query: "x", mode: "bm25" }).mode).toBe("bm25");
      expect(tool.inputSchema.parse({ query: "x", mode: "vector" }).mode).toBe("vector");
      expect(tool.inputSchema.parse({ query: "x", mode: "hybrid" }).mode).toBe("hybrid");
    });

    it("schema rejects unknown mode", () => {
      const tool = createSkillSearchTool(fakeService());
      expect(() => tool.inputSchema.parse({ query: "x", mode: "fts" })).toThrow();
    });

    it("schema accepts hybridAlpha in [0, 1]", () => {
      const tool = createSkillSearchTool(fakeService());
      expect(tool.inputSchema.parse({ query: "x", hybridAlpha: 0 }).hybridAlpha).toBe(0);
      expect(tool.inputSchema.parse({ query: "x", hybridAlpha: 0.5 }).hybridAlpha).toBe(0.5);
      expect(tool.inputSchema.parse({ query: "x", hybridAlpha: 1 }).hybridAlpha).toBe(1);
    });

    it("schema rejects hybridAlpha out of range", () => {
      const tool = createSkillSearchTool(fakeService());
      expect(() => tool.inputSchema.parse({ query: "x", hybridAlpha: -0.1 })).toThrow();
      expect(() => tool.inputSchema.parse({ query: "x", hybridAlpha: 1.5 })).toThrow();
    });

    it("accepts but ignores legacy mode", async () => {
      const svc = fakeService([]);
      const tool = createSkillSearchTool(svc);
      await tool.handler({ query: "x", mode: "hybrid" });
      expect((svc.searchAccessibleSkills as unknown as ReturnType<typeof vi.fn>))
        .toHaveBeenCalledWith(undefined, "x", { limit: 10, tags: undefined });
    });

    it("accepts but ignores legacy hybridAlpha", async () => {
      const svc = fakeService([]);
      const tool = createSkillSearchTool(svc);
      await tool.handler({ query: "x", mode: "hybrid", hybridAlpha: 0.7 });
      expect((svc.searchAccessibleSkills as unknown as ReturnType<typeof vi.fn>))
        .toHaveBeenCalledWith(undefined, "x", { limit: 10, tags: undefined });
    });

    it("omits mode/hybridAlpha when caller doesn't supply them (service applies its own default)", async () => {
      const svc = fakeService([]);
      const tool = createSkillSearchTool(svc);
      await tool.handler({ query: "x" });
      const callArgs = (svc.searchAccessibleSkills as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const opts = callArgs[2];
      expect(opts.mode).toBeUndefined();
      expect(opts.hybridAlpha).toBeUndefined();
    });
  });
});
