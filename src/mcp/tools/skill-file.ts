import { z } from "zod";
import { SKILL_FILE_DESC } from "../../prompt/descriptions.js";
import type { SkillService } from "../../services/skill.service.js";
import { toMcpError } from "../../utils/errors.js";

export function createSkillFileTool(skillService: SkillService) {
  return {
    name: "skill_file" as const,
    description: SKILL_FILE_DESC,
    inputSchema: z.object({
      skill_slug: z.string().optional().describe("技能 slug（来自 skill_list 的 slug 字段）"),
      skill_id: z.string().optional().describe("技能唯一标识（来自 skill_list 的 [id:xxx] 字段）"),
      file_paths: z.array(z.string()).describe(
        "Array of file paths for batch concurrent reading. " +
        'E.g. ["references/api-docs.md", "templates/checklist.md"]',
      ),
    }),
    handler: async (params: { skill_slug?: string; skill_id?: string; file_paths: string[] }) => {
      const identifier = params.skill_id || params.skill_slug;
      if (!identifier) {
        return toMcpError(new Error("必须提供 skill_slug 或 skill_id 其中之一"));
      }
      try {
        const results = await skillService.readSkillFiles(identifier, params.file_paths);
        return {
          content: results.map(r => {
            if (r.encoding === "base64") {
              return {
                type: "image" as const,
                data: r.content,
                mimeType: r.mimeType ?? "application/octet-stream",
              };
            }
            return { type: "text" as const, text: r.content };
          }),
        };
      } catch (error) {
        return toMcpError(error);
      }
    },
  };
}
