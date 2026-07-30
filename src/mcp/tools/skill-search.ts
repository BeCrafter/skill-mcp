import { z } from "zod";
import { SKILL_SEARCH_DESC } from "../prompt/descriptions.js";
import type { SkillService } from "../../services/skill.service.js";
import type { ContextBuilder, McpExtra } from "../../permission/context-builder.js";

/**
 * BM25 keyword search over names, descriptions, triggers, when_to_use and
 * retrieval_meta.embedding_text. `mode` and `hybridAlpha` are accepted only
 * as ignored legacy inputs so existing MCP clients do not fail validation.
 */
export function createSkillSearchTool(skillService: SkillService, contextBuilder?: ContextBuilder) {
  return {
    name: "skill_search" as const,
    description: `${SKILL_SEARCH_DESC} Results are ranked with BM25 keyword search.`,
    inputSchema: z.object({
      query: z.string().min(1).max(512).describe(
        "Free-text query matched against the skill name, description, triggers, when_to_use, and retrieval text.",
      ),
      limit: z.number().int().min(1).max(50).optional().describe(
        "Maximum number of hits to return. Defaults to 10; hard cap 50.",
      ),
      tags: z.array(z.string()).optional().describe(
        "Optional tag filter applied before BM25 ranking.",
      ),
      // Compatibility-only: deliberately undocumented in the tool description.
      mode: z.enum(["bm25", "vector", "hybrid"]).optional(),
      hybridAlpha: z.number().min(0).max(1).optional(),
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
      const hits = await skillService.searchAccessibleSkills(context, params.query, {
        limit: params.limit ?? 10,
        tags: params.tags,
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
      return { content: [{ type: "text" as const, text: header + lines.join("\n") }] };
    },
  };
}
