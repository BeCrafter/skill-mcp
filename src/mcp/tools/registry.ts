import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillService } from "../../services/skill.service.js";
import type { ContextBuilder } from "../../permission/context-builder.js";
import { createSkillListTool } from "./skill-list.js";
import { createSkillViewTool } from "./skill-view.js";
import { createSkillFileTool } from "./skill-file.js";
import { createSkillFeedbackTool } from "./skill-feedback.js";
import { createSkillPipelineTool } from "./skill-pipeline.js";

export function registerTools(server: McpServer, skillService: SkillService, contextBuilder?: ContextBuilder): void {
  const skillList = createSkillListTool(skillService, contextBuilder);
  const skillView = createSkillViewTool(skillService, contextBuilder);
  const skillFile = createSkillFileTool(skillService, contextBuilder);
  const skillFeedback = createSkillFeedbackTool(skillService, contextBuilder);
  const skillPipeline = createSkillPipelineTool(skillService, contextBuilder);

  server.tool(skillList.name, skillList.description, skillList.inputSchema.shape, skillList.handler);
  server.tool(skillView.name, skillView.description, skillView.inputSchema.shape, skillView.handler);
  server.tool(skillFile.name, skillFile.description, skillFile.inputSchema.shape, skillFile.handler);
  server.tool(skillFeedback.name, skillFeedback.description, skillFeedback.inputSchema.shape, skillFeedback.handler);
  server.tool(skillPipeline.name, skillPipeline.description, skillPipeline.inputSchema.shape, skillPipeline.handler);
}
