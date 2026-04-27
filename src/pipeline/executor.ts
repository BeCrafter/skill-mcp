import type { SkillService } from "../services/skill.service.js";
import type { DomainEventBus } from "../events/event-bus.js";
import type { PipelineDefinition, StageDefinition, StageResult, PipelineResult } from "./types.js";
import { DAGScheduler } from "./dag.js";
import { ExecutionContext } from "./context.js";

export class PipelineExecutor {
  constructor(
    private skillService: SkillService,
    private eventBus?: DomainEventBus,
  ) {}

  async execute(pipeline: PipelineDefinition, inputs: Record<string, unknown>): Promise<PipelineResult> {
    // Validate required inputs
    for (const [key, inputDef] of Object.entries(pipeline.inputs)) {
      if (inputDef.required && !(key in inputs)) {
        if (inputDef.default !== undefined) {
          inputs[key] = inputDef.default;
        } else {
          throw new Error(`Required input "${key}" is missing`);
        }
      }
    }

    const dag = new DAGScheduler(pipeline.stages);
    const context = new ExecutionContext(inputs);
    const results: StageResult[] = [];
    const startTime = Date.now();

    for (const batch of dag.getBatches()) {
      // Execute stages in parallel within a batch
      const batchResults = await Promise.allSettled(
        batch.map(stageName => this.executeStage(stageName, pipeline.stages[stageName], context)),
      );

      for (let i = 0; i < batch.length; i++) {
        const result = batchResults[i];
        if (result.status === "fulfilled") {
          context.setStageOutputs(batch[i], result.value.outputs);
          results.push(result.value);
        } else {
          results.push({
            stage: batch[i],
            status: "failure",
            outputs: {},
            duration_ms: 0,
            error: result.reason?.message ?? "Unknown error",
          });
        }
      }

      // If any stage in this batch failed, stop execution
      const hasFailures = results.filter(r => r.status === "failure").length > 0;
      if (hasFailures) {
        break;
      }
    }

    const allSuccess = results.every(r => r.status === "success");
    const totalDuration = Date.now() - startTime;

    return {
      name: pipeline.name,
      status: allSuccess ? "success" : "partial",
      stages: results,
      output: context.resolveOutputs(pipeline.output),
      total_duration_ms: totalDuration,
    };
  }

  private async executeStage(
    name: string,
    stage: StageDefinition,
    context: ExecutionContext,
  ): Promise<StageResult> {
    const start = Date.now();

    try {
      // Resolve input expressions
      const resolvedInputs = context.resolveExpressions(stage.inputs);

      // Get skill entry content
      const skillExists = await this.skillService.skillExists(stage.skill);
      if (!skillExists) {
        throw new Error(`Skill "${stage.skill}" not found`);
      }

      const skillEntry = await this.skillService.viewSkillEntry(stage.skill);

      // In a real execution, this would be passed to an LLM agent to execute
      // For now, we return the skill entry and resolved inputs as the output
      const outputs: Record<string, unknown> = {
        skill_entry: skillEntry,
        resolved_inputs: resolvedInputs,
        // In production, outputs would be provided by the LLM execution
      };

      return {
        stage: name,
        status: "success",
        outputs,
        duration_ms: Date.now() - start,
      };
    } catch (error) {
      return {
        stage: name,
        status: "failure",
        outputs: {},
        duration_ms: Date.now() - start,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
