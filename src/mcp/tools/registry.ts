import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillService } from "../../services/skill.service.js";
import type { ContextBuilder } from "../../permission/context-builder.js";
import type { PipelineRunStore } from "../../pipeline/run-store.js";
import { metrics } from "../../telemetry/metrics.js";
import { createSkillListTool } from "./skill-list.js";
import { createSkillViewTool } from "./skill-view.js";
import { createSkillFileTool } from "./skill-file.js";
import { createSkillFeedbackTool } from "./skill-feedback.js";
import { createSkillPipelineTool } from "./skill-pipeline.js";

// Wrap a tool handler to record per-tool counter and duration without losing
// its original parameter/return signature — the McpServer SDK enforces a
// specific shape for the response, so the wrapper has to be transparent.
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

export function registerTools(
  server: McpServer,
  skillService: SkillService,
  contextBuilder?: ContextBuilder,
  pipelineRunStore?: PipelineRunStore,
): void {
  const skillList = createSkillListTool(skillService, contextBuilder);
  const skillView = createSkillViewTool(skillService, contextBuilder);
  const skillFile = createSkillFileTool(skillService, contextBuilder);
  const skillFeedback = createSkillFeedbackTool(skillService, contextBuilder);
  const skillPipeline = createSkillPipelineTool(skillService, contextBuilder, pipelineRunStore);

  server.tool(skillList.name, skillList.description, skillList.inputSchema.shape, instrument(skillList.name, skillList.handler));
  server.tool(skillView.name, skillView.description, skillView.inputSchema.shape, instrument(skillView.name, skillView.handler));
  server.tool(skillFile.name, skillFile.description, skillFile.inputSchema.shape, instrument(skillFile.name, skillFile.handler));
  server.tool(skillFeedback.name, skillFeedback.description, skillFeedback.inputSchema.shape, instrument(skillFeedback.name, skillFeedback.handler));
  server.tool(skillPipeline.name, skillPipeline.description, skillPipeline.inputSchema.shape, instrument(skillPipeline.name, skillPipeline.handler));
}
