import { z } from "zod";
import { SKILL_LIST_DESC } from "../../prompt/descriptions.js";
import type { SkillService } from "../../services/skill.service.js";
import type { ContextBuilder, McpExtra } from "../../permission/context-builder.js";

export function createSkillListTool(skillService: SkillService, contextBuilder?: ContextBuilder) {
  return {
    name: "skill_list" as const,
    description: SKILL_LIST_DESC,
    inputSchema: z.object({
      tags: z.array(z.string()).optional().describe(
        "Filter skills by capability tags. Omit to return all accessible skills. " +
        "See available tags in the tag directory from first skill_list() call",
      ),
      query: z.string().min(1).max(512).optional().describe(
        "Optional free-text query — when set, the result is filtered + reordered " +
        "by BM25 relevance (top 20). Faster path than skill_search when you only " +
        "need the index, not scores.",
      ),
    }),
    handler: async (params: { tags?: string[]; query?: string }, extra?: McpExtra) => {
      const context = contextBuilder && extra ? await contextBuilder(extra) : undefined;
      const index = await skillService.listSkillsIndex(context, params.tags, params.query);
      const header = "[扩展技能 / Extension Skills]\n格式: - slug [id:uuid]: 描述\n";
      const body = index || "当前没有可用的扩展技能。";
      return {
        content: [{ type: "text" as const, text: header + body }],
      };
    },
  };
}
