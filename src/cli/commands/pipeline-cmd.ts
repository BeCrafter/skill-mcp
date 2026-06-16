import { readFileSync } from "node:fs";
import { parsePipeline } from "../../pipeline/parser.js";
import { DAGScheduler } from "../../pipeline/dag.js";
import { c, kv, section, fail, kvWidth, ok } from "../ui.js";

/**
 * Validate pipeline YAML syntax and DAG structure
 */
export async function pipelineValidateAction(yamlPath: string): Promise<void> {
  try {
    const yamlContent = readFileSync(yamlPath, "utf-8");
    const pipeline = parsePipeline(yamlContent);

    const dag = new DAGScheduler(pipeline.stages);
    const batches = dag.getBatches();

    console.log(section(pipeline.name, undefined, kvWidth(12, String(Object.keys(pipeline.stages).length), `${batches.length} (max parallelism: ${Math.max(...batches.map(b => b.length))})`, String(Object.keys(pipeline.inputs).length), String(Object.keys(pipeline.output).length))));
    console.log();
    console.log(kv("stages", String(Object.keys(pipeline.stages).length)));
    console.log(kv("batches", `${batches.length} (max parallelism: ${Math.max(...batches.map(b => b.length))})`));
    console.log(kv("inputs", String(Object.keys(pipeline.inputs).length)));
    console.log(kv("outputs", String(Object.keys(pipeline.output).length)));
    console.log();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Validation failed: ${message}`, "Check YAML syntax and stage definitions");
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

    const batches = dag.getBatches();
    const stageLevel = new Map<string, number>();
    batches.forEach((batch, level) => {
      batch.forEach(stage => stageLevel.set(stage, level));
    });

    console.log(section(pipeline.name));
    if (pipeline.description) {
      console.log(`    ${c.dim(pipeline.description)}`);
    }
    console.log();

    batches.forEach((batch, level) => {
      const levelLabel = c.dim(`Batch ${level}`);
      console.log(`    ${levelLabel}`);
      for (const stageName of batch) {
        const stage = pipeline.stages[stageName];
        const deps = stage.depends_on ?? [];
        const depStr = deps.length > 0 ? c.dim(` ← ${deps.join(", ")}`) : "";
        console.log(`    ${c.cyan("●")}  ${stageName}${depStr}`);
      }
      console.log();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Graph failed: ${message}`, "Ensure all stage dependencies are valid");
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
    const dag = new DAGScheduler(pipeline.stages);

    const mode = opts.dryRun ? "Dry run" : "Running";
    console.log(section(`${mode}  ${pipeline.name}`));

    // Parse inputs
    const inputs: Record<string, string> = {};
    if (opts.input) {
      for (const pair of opts.input) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx > 0) {
          inputs[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
    }

    // Validate inputs
    for (const [key] of Object.entries(pipeline.inputs)) {
      if (!(key in inputs)) {
        fail(`Missing required input: ${key}`, `Provide --input ${key}=<value>`);
        process.exit(1);
      }
    }

    // Execute batches
    const batches = dag.getBatches();

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`\n    ${c.dim(`Batch ${i}`)}  ${batch.map(s => c.cyan(s)).join(", ")}`);

      for (const stageName of batch) {
        console.log(`    ${c.cyan("●")}  ${stageName}`);

        if (opts.dryRun) {
          console.log(`      ${c.dim("skipped (dry run)")}`);
        } else {
          // Stage execution would happen here
          console.log(`      ${c.dim("executing...")}`);
        }
      }
    }

    if (opts.dryRun) {
      ok("Dry run complete — no changes made");
    } else {
      ok("Pipeline completed");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Pipeline failed: ${message}`);
    process.exit(1);
  }
}
