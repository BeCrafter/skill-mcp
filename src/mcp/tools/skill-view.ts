import { z } from "zod";
import { SKILL_VIEW_DESC } from "../../prompt/descriptions.js";
import { SkillNotFoundError, toMcpError } from "../../utils/errors.js";
import type { SkillService } from "../../services/skill.service.js";
import type { ContextBuilder, McpExtra } from "../../permission/context-builder.js";

export function createSkillViewTool(skillService: SkillService, contextBuilder?: ContextBuilder) {
  return {
    name: "skill_view" as const,
    description: SKILL_VIEW_DESC,
    inputSchema: z.object({
      skill_slug: z.string().optional().describe("Skill slug from skill_list"),
      skill_id: z.string().optional().describe("Skill ID from skill_list [id:xxx]"),
    }),
    handler: async (params: { skill_slug?: string; skill_id?: string }, extra?: McpExtra) => {
      const identifier = params.skill_id || params.skill_slug;
      if (!identifier) {
        return toMcpError(new Error("Must provide skill_slug or skill_id"));
      }
      try {
        const context = contextBuilder && extra ? await contextBuilder(extra) : undefined;
        const content = await skillService.viewSkillEntry(identifier, context);
        return {
          content: [{ type: "text" as const, text: content }],
        };
      } catch (error) {
        return toMcpError(error);
      }
    },
  };
}
