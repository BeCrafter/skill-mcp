import { load as parseYaml } from "js-yaml";
import type { PipelineDefinition, StageDefinition } from "./types.js";

export function parsePipeline(yamlContent: string): PipelineDefinition {
  try {
    const doc = parseYaml(yamlContent) as unknown;

    if (!doc || typeof doc !== "object") {
      throw new Error("Invalid pipeline YAML: must be an object");
    }

    const pipeline = doc as Record<string, unknown>;

    if (!pipeline.name || typeof pipeline.name !== "string") {
      throw new Error("Pipeline name is required");
    }

    if (!pipeline.stages || typeof pipeline.stages !== "object") {
      throw new Error("Pipeline must have stages");
    }

    // Validate and parse stages
    const stages: Record<string, StageDefinition> = {};
    for (const [stageName, stageValue] of Object.entries(pipeline.stages as Record<string, unknown>)) {
      if (!stageValue || typeof stageValue !== "object") {
        throw new Error(`Stage "${stageName}" must be an object`);
      }
      const stage = stageValue as Record<string, unknown>;
      if (!stage.skill || typeof stage.skill !== "string") {
        throw new Error(`Stage "${stageName}" must specify a skill`);
      }
      if (!stage.outputs || !Array.isArray(stage.outputs)) {
        throw new Error(`Stage "${stageName}" must define outputs array`);
      }
      if (!stage.inputs || typeof stage.inputs !== "object") {
        throw new Error(`Stage "${stageName}" must have inputs object`);
      }

      stages[stageName] = {
        skill: stage.skill,
        depends_on: stage.depends_on as string[] | undefined,
        inputs: stage.inputs as Record<string, unknown>,
        outputs: stage.outputs as string[],
        condition: stage.condition as string | undefined,
        retry: stage.retry as { max: number; delay_ms: number } | undefined,
      };
    }

    // Parse inputs
    const inputs: PipelineDefinition["inputs"] = {};
    if (pipeline.inputs && typeof pipeline.inputs === "object") {
      for (const [key, value] of Object.entries(pipeline.inputs as Record<string, unknown>)) {
        if (value && typeof value === "object") {
          const inputDef = value as Record<string, unknown>;
          inputs[key] = {
            type: (inputDef.type as string) ?? "string",
            required: inputDef.required as boolean | undefined,
            default: inputDef.default,
          };
        }
      }
    }

    // Parse output
    const output: Record<string, string> = {};
    if (pipeline.output && typeof pipeline.output === "object") {
      for (const [key, value] of Object.entries(pipeline.output as Record<string, unknown>)) {
        if (typeof value === "string") {
          output[key] = value;
        }
      }
    }

    return {
      name: pipeline.name,
      description: pipeline.description as string | undefined,
      inputs,
      stages,
      output,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse pipeline: ${error.message}`);
    }
    throw error;
  }
}
