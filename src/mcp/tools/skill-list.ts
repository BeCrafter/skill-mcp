import { z } from "zod";
import { SKILL_LIST_DESC } from "../../prompt/descriptions.js";
import type { SkillService } from "../../services/skill.service.js";

export function createSkillListTool(skillService: SkillService) {
  return {
    name: "skill_list" as const,
    description: SKILL_LIST_DESC,
    inputSchema: z.object({}),
    handler: async () => {
      const index = await skillService.listSkillsIndex();
      return {
        content: [{ type: "text" as const, text: index || "No skills available." }],
      };
    },
  };
}
