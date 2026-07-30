import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillService } from "../services/skill.service.js";
import type { ISkillProvider } from "../provider/interface.js";
import type { ContextBuilder } from "../permission/context-builder.js";
import { buildSkillSystemPrompt } from "./prompt/system-prompt.js";
import { registerTools } from "./tools/registry.js";

export async function createMcpServer(
  skillService: SkillService,
  _skillProvider: ISkillProvider,
  serverName?: string,
  serverVersion?: string,
  contextBuilder?: ContextBuilder,
): Promise<McpServer> {
  const server = new McpServer(
    { name: serverName ?? "skill-mcp", version: serverVersion ?? "0.1.0" },
    { instructions: buildSkillSystemPrompt() },
  );
  registerTools(server, skillService, contextBuilder);
  return server;
}
