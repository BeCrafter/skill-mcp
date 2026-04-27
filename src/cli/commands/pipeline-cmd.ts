import { readFileSync } from "node:fs";
import { parsePipeline } from "../../pipeline/parser.js";
import { DAGScheduler } from "../../pipeline/dag.js";

/**
 * Validate pipeline YAML syntax and DAG structure
 */
export async function pipelineValidateAction(yamlPath: string): Promise<void> {
  try {
    const yamlContent = readFileSync(yamlPath, "utf-8");
    const pipeline = parsePipeline(yamlContent);

    // Try to build DAG (will throw if circular dependency detected)
    const dag = new DAGScheduler(pipeline.stages);
    const batches = dag.getBatches();

    console.log(`✓ Pipeline "${pipeline.name}" is valid`);
    console.log(`  Stages: ${Object.keys(pipeline.stages).length}`);
    console.log(`  Batches: ${batches.length} (max parallelism: ${Math.max(...batches.map(b => b.length))})`);
    console.log(`  Inputs: ${Object.keys(pipeline.inputs).length}`);
    console.log(`  Outputs: ${Object.keys(pipeline.output).length}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ Validation failed: ${message}`);
    process.exit(1);
  }
}

/**
 * Visualize pipeline DAG as ASCII tree
 */
export async function pipelineGraphAction(yamlPath: string): Promise<void> {
  try {
    const yamlContent = readFileSync(yamlPath, "utf-8");
    const pipeline = parsePipeline(yamlContent);
    const dag = new DAGScheduler(pipeline.stages);

    console.log(`Pipeline: ${pipeline.name}`);
    if (pipeline.description) {
      console.log(`Description: ${pipeline.description}`);
    }
    console.log();

    // Build adjacency info for visualization
    const batches = dag.getBatches();
    const stageLevel = new Map<string, number>();
    batches.forEach((batch, level) => {
      batch.forEach(stage => stageLevel.set(stage, level));
    });

    // Print stages grouped by batch (execution level)
    batches.forEach((batch, level) => {
      console.log(`Batch ${level + 1} (parallel execution):`);
      batch.forEach(stageName => {
        const stage = pipeline.stages[stageName];
        const deps = stage.depends_on || [];
        const indent = "  ";
        if (deps.length === 0) {
          console.log(`${indent}${stageName} [skill: ${stage.skill}]`);
        } else {
          console.log(`${indent}${stageName} [skill: ${stage.skill}] ← depends on: ${deps.join(", ")}`);
        }
      });
      console.log();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ Graph generation failed: ${message}`);
    process.exit(1);
  }
}

/**
 * Execute pipeline (dry-run or real execution)
 */
export async function pipelineRunAction(
  yamlPath: string,
  opts: { input?: string[]; dryRun?: boolean },
): Promise<void> {
  try {
    const yamlContent = readFileSync(yamlPath, "utf-8");
    const pipeline = parsePipeline(yamlContent);

    // Parse input flags: --input key=value --input foo=bar
    const inputs: Record<string, unknown> = {};
    if (opts.input) {
      for (const pair of opts.input) {
        const [key, value] = pair.split("=", 2);
        if (!key || value === undefined) {
          throw new Error(`Invalid input format: "${pair}". Expected key=value`);
        }
        // Try to parse as JSON, fallback to string
        try {
          inputs[key] = JSON.parse(value);
        } catch {
          inputs[key] = value;
        }
      }
    }

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

    if (opts.dryRun) {
      console.log(`Dry-run mode: Pipeline "${pipeline.name}"`);
      console.log(`Inputs:`, JSON.stringify(inputs, null, 2));
      console.log();

      const dag = new DAGScheduler(pipeline.stages);
      const batches = dag.getBatches();

      console.log("Execution plan:");
      batches.forEach((batch, level) => {
        console.log(`  Batch ${level + 1}:`);
        batch.forEach(stageName => {
          const stage = pipeline.stages[stageName];
          console.log(`    - ${stageName} (skill: ${stage.skill})`);
        });
      });
      console.log();
      console.log("✓ Dry-run completed (no actual execution)");
    } else {
      // Real execution would require SkillService instance
      console.error("✗ Real execution not supported from CLI yet");
      console.error("  Use the MCP tool 'skill_pipeline' for execution via AI agent");
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ Pipeline execution failed: ${message}`);
    process.exit(1);
  }
}
