import { z } from "zod";
import { toMcpError } from "../../utils/errors.js";
import type { SkillService } from "../../services/skill.service.js";
import type { ContextBuilder, McpExtra } from "../../permission/context-builder.js";
import { parsePipeline } from "../../pipeline/parser.js";
import { PipelineExecutor } from "../../pipeline/executor.js";
import { PipelineRunStore } from "../../pipeline/run-store.js";

// Fallback in-memory store for callers that don't provide one (tests, stdio
// without DB). Production wiring (serve-cmd) injects a DB-backed store via
// createSkillPipelineTool's `runStore` param so runs survive process restart.
const fallbackRunStore = new PipelineRunStore();

const SKILL_PIPELINE_DESC = [
  "【Skill Pipeline】Execute a DAG (Directed Acyclic Graph) of skills in orchestrated order.",
  "",
  "This tool allows you to compose multiple skills into a pipeline where:",
  "- Stages execute in parallel when dependencies allow",
  "- Outputs from one stage can be used as inputs to dependent stages",
  "- Data flows through the pipeline via expression syntax: ${{ inputs.xxx }} and ${{ stages.xxx.outputs.yyy }}",
  "",
  "Pipeline is defined in YAML format with:",
  "- name: Pipeline name",
  "- inputs: Required and optional input parameters",
  "- stages: Map of stage definitions (each binding to a skill)",
  "- output: Final output expressions",
  "",
  "Example pipeline YAML:",
  "```yaml",
  "name: code-review",
  "inputs:",
  "  pr_url:",
  "    type: string",
  "    required: true",
  "stages:",
  "  fetch:",
  "    skill: github-pr-reader",
  "    inputs:",
  "      url: ${{ inputs.pr_url }}",
  "    outputs: [diff, files]",
  "  security:",
  "    skill: security-scanner",
  "    depends_on: [fetch]",
  "    inputs:",
  "      code: ${{ stages.fetch.outputs.diff }}",
  "    outputs: [vulnerabilities]",
  "output:",
  "  report: ${{ stages.security.outputs.vulnerabilities }}",
  "```",
].join("\n");

export function createSkillPipelineTool(
  skillService: SkillService,
  contextBuilder?: ContextBuilder,
  runStore?: PipelineRunStore,
) {
  const store = runStore ?? fallbackRunStore;
  return {
    name: "skill_pipeline" as const,
    description: SKILL_PIPELINE_DESC,
    inputSchema: z.object({
      pipeline: z.string().optional().describe("Pipeline definition in YAML format (required for new runs)"),
      inputs: z.record(z.unknown()).optional().describe("Pipeline input values (required for new runs)"),
      resume: z.object({
        run_id: z.string(),
        stage_outputs: z.record(z.record(z.unknown())),
      }).optional().describe("Resume a paused pipeline with stage execution results"),
    }),
    handler: async (
      params: { pipeline?: string; inputs?: Record<string, unknown>; resume?: { run_id: string; stage_outputs: Record<string, Record<string, unknown>> } },
      extra?: McpExtra,
    ) => {
      try {
        // T-502: resolve the caller's RequestContext once per tool call so
        // every viewSkillEntry inside the pipeline applies the same per-user
        // permission filter as direct skill_view calls. Without this, a
        // stage could read a private skill the caller is not allowed to see.
        const requestContext = contextBuilder ? await contextBuilder(extra ?? {}) : undefined;
        if (params.resume) {
          // Resume path: Agent provides execution results for stages
          const executor = new PipelineExecutor(skillService, store);
          const result = await executor.resume(params.resume.run_id, params.resume.stage_outputs, requestContext);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } else if (params.pipeline) {
          // New run path: Start a new pipeline execution
          const pipelineDef = parsePipeline(params.pipeline);
          const executor = new PipelineExecutor(skillService, store);
          const result = await executor.start(pipelineDef, params.inputs ?? {}, requestContext);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } else {
          return toMcpError("Either pipeline or resume parameter is required");
        }
      } catch (error) {
        return toMcpError(error);
      }
    },
  };
}
