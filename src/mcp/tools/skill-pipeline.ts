import { z } from "zod";
import { toMcpError } from "../../utils/errors.js";
import type { SkillService } from "../../services/skill.service.js";
import type { ContextBuilder, McpExtra } from "../../permission/context-builder.js";
import { parsePipeline } from "../../pipeline/parser.js";
import { PipelineExecutor } from "../../pipeline/executor.js";

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

export function createSkillPipelineTool(skillService: SkillService, _contextBuilder?: ContextBuilder) {
  return {
    name: "skill_pipeline" as const,
    description: SKILL_PIPELINE_DESC,
    inputSchema: z.object({
      pipeline: z.string().describe("Pipeline definition in YAML format"),
      inputs: z.record(z.unknown()).describe("Pipeline input values"),
    }),
    handler: async (params: { pipeline: string; inputs: Record<string, unknown> }, _extra?: McpExtra) => {
      try {
        const pipelineDef = parsePipeline(params.pipeline);
        const executor = new PipelineExecutor(skillService);
        const result = await executor.execute(pipelineDef, params.inputs);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return toMcpError(error);
      }
    },
  };
}
