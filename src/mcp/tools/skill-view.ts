import { z } from "zod";
import { SKILL_VIEW_DESC } from "../../prompt/descriptions.js";
import { SkillNotFoundError, toMcpError } from "../../utils/errors.js";
import type { SkillService } from "../../services/skill.service.js";

export function createSkillViewTool(skillService: SkillService) {
  return {
    name: "skill_view" as const,
    description: SKILL_VIEW_DESC,
    inputSchema: z.object({
      skill_slug: z.string().describe("Skill unique identifier (slug)"),
    }),
    handler: async (params: { skill_slug: string }) => {
      try {
        const content = await skillService.viewSkillEntry(params.skill_slug);
        return {
          content: [{ type: "text" as const, text: content }],
        };
      } catch (error) {
        return toMcpError(error);
      }
    },
  };
}
