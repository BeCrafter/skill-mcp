import { z } from "zod";
import { SKILL_FILE_DESC } from "../prompt/descriptions.js"
import type { SkillService } from "../../services/skill.service.js";
import { toMcpError } from "../../utils/errors.js";
import type { ContextBuilder, McpExtra } from "../../permission/context-builder.js";

export function createSkillFileTool(skillService: SkillService, contextBuilder?: ContextBuilder) {
  return {
    name: "skill_file" as const,
    description: SKILL_FILE_DESC,
    inputSchema: z.object({
      skill_slug: z.string().optional().describe("Skill slug from skill_list"),
      skill_id: z.string().optional().describe("Skill ID from skill_list [id:xxx]"),
      file_paths: z.array(z.string()).describe(
        "Array of file paths for batch concurrent reading. " +
        'E.g. ["references/api-docs.md", "templates/checklist.md"]',
      ),
    }),
    handler: async (params: { skill_slug?: string; skill_id?: string; file_paths: string[] }, extra?: McpExtra) => {
      const identifier = params.skill_id || params.skill_slug;
      if (!identifier) {
        return toMcpError(new Error("Must provide skill_slug or skill_id"));
      }
      try {
        const context = contextBuilder && extra ? await contextBuilder(extra) : undefined;
        const results = await skillService.readSkillFiles(identifier, params.file_paths, context);
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
