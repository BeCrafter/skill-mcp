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
      const header = "[扩展技能 / Extension Skills]\n格式: - slug [id:uuid]: 描述\n";
      const body = index || "当前没有可用的扩展技能。";
      return {
        content: [{ type: "text" as const, text: header + body }],
      };
    },
  };
}
