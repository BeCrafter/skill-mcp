import { z } from "zod";
import { SKILL_FEEDBACK_DESC } from "../../prompt/descriptions.js";
import type { SkillService } from "../../services/skill.service.js";
import { toMcpError } from "../../utils/errors.js";
import type { ContextBuilder, McpExtra } from "../../permission/context-builder.js";

export function createSkillFeedbackTool(skillService: SkillService, contextBuilder?: ContextBuilder) {
  return {
    name: "skill_feedback" as const,
    description: SKILL_FEEDBACK_DESC,
    inputSchema: z.object({
      skill_slug: z.string().max(255).describe("Skill slug"),
      outcome: z.enum(["success", "partial", "failure", "irrelevant"])
        .describe("Result: success=fully succeeded, partial=partially succeeded, failure=failed, irrelevant=not applicable"),
      // T-727 — bound user-writable text columns. The 10 MiB body cap
      // alone lets an authenticated client pour multi-MB strings into
      // skill_feedbacks per call, bloating SQLite + every effectiveness
      // / audit listing that walks these rows.
      context: z.string().max(2000).describe("Brief description of the usage scenario"),
      agent_comment: z.string().max(8000).describe("Agent self-assessment, e.g. whether skill instructions were clear and steps were effective"),
    }),
    handler: async (input: { skill_slug: string; outcome: string; context: string; agent_comment: string }, extra?: McpExtra) => {
      try {
        const context = contextBuilder && extra ? await contextBuilder(extra) : undefined;
        await skillService.submitFeedback(input, context);
        return {
          content: [{
            type: "text" as const,
            text: `Feedback recorded for skill "${input.skill_slug}": ${input.outcome}`,
          }],
        };
      } catch (error) {
        return toMcpError(error);
      }
    },
  };
}
