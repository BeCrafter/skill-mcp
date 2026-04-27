import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillService } from "../services/skill.service.js";
import type { ISkillProvider } from "../provider/interface.js";
import { buildSkillSystemPrompt } from "../prompt/system-prompt.js";
import { registerTools } from "./tools/registry.js";

export async function createMcpServer(
  skillService: SkillService,
  skillProvider: ISkillProvider,
  serverName?: string,
  serverVersion?: string,
): Promise<McpServer> {
  // Build instructions from skill list first (await to ensure they're ready)
  const skills = await skillProvider.listSkills();
  const instructions = buildSkillSystemPrompt(skills);

  // McpServer passes options through to the underlying Server,
  // which natively supports the `instructions` field.
  const server = new McpServer(
    {
      name: serverName ?? "skill-mcp-server",
      version: serverVersion ?? "1.0.0",
    },
    { instructions },
  );

  // Register tools
  registerTools(server, skillService);

  return server;
}
