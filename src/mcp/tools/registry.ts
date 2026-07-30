import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillService } from "../../services/skill.service.js";
import type { ContextBuilder } from "../../permission/context-builder.js";
import { metrics } from "../../telemetry/metrics.js";
import { createSkillListTool } from "./skill-list.js";
import { createSkillSearchTool } from "./skill-search.js";
import { createSkillViewTool } from "./skill-view.js";
import { createSkillFileTool } from "./skill-file.js";
import { createSkillFeedbackTool } from "./skill-feedback.js";

function instrument<H extends (...args: never[]) => Promise<unknown>>(name: string, handler: H): H {
  const wrapped = async (...args: Parameters<H>) => {
    const end = metrics.mcpToolDuration.startTimer({ tool: name });
    try {
      const result = await handler(...args);
      metrics.mcpToolCalls.inc({ tool: name, status: "ok" });
      end({ status: "ok" });
      return result;
    } catch (err) {
      metrics.mcpToolCalls.inc({ tool: name, status: "error" });
      end({ status: "error" });
      throw err;
    }
  };
  return wrapped as unknown as H;
}

export function registerTools(server: McpServer, skillService: SkillService, contextBuilder?: ContextBuilder): void {
  const tools = [
    createSkillListTool(skillService, contextBuilder),
    createSkillSearchTool(skillService, contextBuilder),
    createSkillViewTool(skillService, contextBuilder),
    createSkillFileTool(skillService, contextBuilder),
    createSkillFeedbackTool(skillService, contextBuilder),
  ];
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.inputSchema.shape, instrument(tool.name, tool.handler));
  }
}
