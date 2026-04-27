import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillService } from "../services/skill.service.js";
import type { ISkillProvider } from "../provider/interface.js";
import type { ContextBuilder } from "../permission/context-builder.js";
import { buildSkillSystemPrompt } from "../prompt/system-prompt.js";
import { registerTools } from "./tools/registry.js";

export async function createMcpServer(
  skillService: SkillService,
  skillProvider: ISkillProvider,
  serverName?: string,
  serverVersion?: string,
  contextBuilder?: ContextBuilder,
): Promise<McpServer> {
  const skills = await skillProvider.listSkills();
  let instructions = buildSkillSystemPrompt(skills);

  // Append tag directory
  const allTags = new Set<string>();
  for (const skill of skills) {
    if (Array.isArray(skill.tags)) {
      skill.tags.forEach(t => allTags.add(t));
    }
  }
  if (allTags.size > 0) {
    instructions += `\n\n[Available tags: ${[...allTags].sort().join(", ")}]`;
    instructions += `\nCall skill_list({tags: ["tag"]}) to filter skills by tag.`;
  }

  const server = new McpServer(
    {
      name: serverName ?? "skill-mcp",
      version: serverVersion ?? "0.0.1",
    },
    { instructions },
  );

  registerTools(server, skillService, contextBuilder);

  return server;
}
