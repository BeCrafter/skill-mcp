import { z } from "zod";
import { SKILL_SEARCH_DESC } from "../prompt/descriptions.js"
import type { SkillService } from "../../services/skill.service.js";
import type { ContextBuilder, McpExtra } from "../../permission/context-builder.js";

/**
 * P1-11 stages 2b + 3 — relevance-ranked skill search.
 *  - Default mode "bm25" matches stage 2b behaviour exactly.
 *  - "vector" runs cosine similarity over the embedding sidecar — useful
 *    when the agent's query and the skill's name/description don't share
 *    keywords (e.g. paraphrased intent).
 *  - "hybrid" combines both signals via a tunable α — recommended general
 *    setting when an embedding provider is configured.
 *
 * When no embedding provider is configured (NullEmbeddingProvider, the
 * open-source default), "vector" / "hybrid" silently fall back to "bm25"
 * inside the service layer — the response shape is identical so callers
 * never need a feature-flag dance.
 */
export function createSkillSearchTool(skillService: SkillService, contextBuilder?: ContextBuilder) {
  return {
    name: "skill_search" as const,
    description: SKILL_SEARCH_DESC,
    inputSchema: z.object({
      query: z.string().min(1).max(512).describe(
        "Free-text query describing the user's intent. Tokenized and matched against " +
        "the skill name, description, triggers, and when_to_use fields.",
      ),
      limit: z.number().int().min(1).max(50).optional().describe(
        "Maximum number of hits to return. Defaults to 10; hard cap 50.",
      ),
      tags: z.array(z.string()).optional().describe(
        "Optional tag filter applied BEFORE ranking — narrows the candidate set.",
      ),
      mode: z.enum(["bm25", "vector", "hybrid"]).optional().describe(
        "Ranking signal. 'bm25' (default) keyword match; 'vector' cosine over embeddings; " +
        "'hybrid' combines both. Falls back to 'bm25' when no embedding provider is configured.",
      ),
      hybridAlpha: z.number().min(0).max(1).optional().describe(
        "Weight on BM25 in hybrid mode. 1.0 = BM25 only, 0.0 = vector only. Default 0.5.",
      ),
    }),
    handler: async (
      params: {
        query: string;
        limit?: number;
        tags?: string[];
        mode?: "bm25" | "vector" | "hybrid";
        hybridAlpha?: number;
      },
      extra?: McpExtra,
    ) => {
      const context = contextBuilder && extra ? await contextBuilder(extra) : undefined;
      const limit = params.limit ?? 10;
      const hits = await skillService.searchAccessibleSkills(context, params.query, {
        limit,
        tags: params.tags,
        mode: params.mode,
        hybridAlpha: params.hybridAlpha,
      });
      const header = `[Skill Search Results — query: ${params.query}]\nFormat: - slug [id:uuid] (score=N.NNN): description\n`;
      if (hits.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: header + "No matching skills found. Try widening the query or calling skill_list() to browse the full catalog.",
          }],
        };
      }
      const lines = hits.map(({ skill, score }) => {
        const desc = (skill.description ?? "").length > 80
          ? (skill.description ?? "").slice(0, 77) + "..."
          : (skill.description ?? "");
        return `    - ${skill.slug} [id:${skill.id}] (score=${score.toFixed(3)}): ${desc}`;
      });
      return {
        content: [{ type: "text" as const, text: header + lines.join("\n") }],
      };
    },
  };
}
