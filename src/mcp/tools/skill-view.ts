import { z } from "zod";
import { SKILL_VIEW_DESC } from "../../prompt/descriptions.js";
import { SkillNotFoundError, toMcpError } from "../../utils/errors.js";
import type { SkillService } from "../../services/skill.service.js";

export function createSkillViewTool(skillService: SkillService) {
  return {
    name: "skill_view" as const,
    description: SKILL_VIEW_DESC,
    inputSchema: z.object({
      skill_slug: z.string().optional().describe("技能 slug（来自 skill_list 的 slug 字段）"),
      skill_id: z.string().optional().describe("技能唯一标识（来自 skill_list 的 [id:xxx] 字段）"),
    }),
    handler: async (params: { skill_slug?: string; skill_id?: string }) => {
      const identifier = params.skill_id || params.skill_slug;
      if (!identifier) {
        return toMcpError(new Error("必须提供 skill_slug 或 skill_id 其中之一"));
      }
      try {
        const content = await skillService.viewSkillEntry(identifier);
        return {
          content: [{ type: "text" as const, text: content }],
        };
      } catch (error) {
        return toMcpError(error);
      }
    },
  };
}
