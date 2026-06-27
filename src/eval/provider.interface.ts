/**
 * P1-12 stage 2 — minimal provider interface for the eval runner.
 *
 * Supports two modes:
 * - Single skill: `skillEntry` contains the skill content
 * - Pipeline: `pipelineInstructions` contains the composed rules from PipelineResult
 */
export interface EvalProviderResult {
  /** Final output text the assertions run against. */
  output: string;
  /** Tool names the provider invoked, in call order. */
  toolsUsed: string[];
}

export interface EvalInput {
  /** Original user input / test case input. */
  input: string;
  /** Single skill mode: skill entry content. */
  skillEntry?: string;
  /** Pipeline mode: composed instructions from PipelineResult. */
  pipelineInstructions?: string;
  /** Stage outputs for pipeline resume scenarios. */
  stageOutputs?: Record<string, Record<string, unknown>>;
}

export interface EvalProvider {
  /** Identifier persisted into `skill_eval_runs.runner` for audit. */
  readonly name: string;
  run(input: EvalInput, ctx: { skillSlug: string; caseName: string }): Promise<EvalProviderResult>;
}
