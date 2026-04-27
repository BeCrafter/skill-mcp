import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillService } from "../../services/skill.service.js";
import { createSkillListTool } from "./skill-list.js";
import { createSkillViewTool } from "./skill-view.js";
import { createSkillFileTool } from "./skill-file.js";

export function registerTools(server: McpServer, skillService: SkillService): void {
  const skillList = createSkillListTool(skillService);
  const skillView = createSkillViewTool(skillService);
  const skillFile = createSkillFileTool(skillService);

  // McpServer.tool() accepts name, description, shape (plain object), and handler
  server.tool(skillList.name, skillList.description, skillList.inputSchema.shape, skillList.handler);
  server.tool(skillView.name, skillView.description, skillView.inputSchema.shape, skillView.handler);
  server.tool(skillFile.name, skillFile.description, skillFile.inputSchema.shape, skillFile.handler);
}
