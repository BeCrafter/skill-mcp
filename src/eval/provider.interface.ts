/**
 * P1-12 stage 2 — minimal provider interface for the eval runner. Stage 2
 * ships only the `EchoEvalProvider` (input → output passthrough); stage 3
 * swaps in real LLM providers without changing the runner contract.
 *
 * Why no streaming / partials / metadata? Because stage 2 only needs to
 * exercise the assertion machinery end-to-end. Adding richer signals here
 * before there is an actual model behind the interface would be speculative
 * design — stage 3 broadens the interface when concrete providers land.
 */
export interface EvalProviderResult {
  /** Final output text the assertions run against. */
  output: string;
  /**
   * Tool names the provider invoked, in call order. Order is preserved so
   * future expectations can assert on sequence; the stage-2 assertion only
   * checks set membership.
   */
  toolsUsed: string[];
}

export interface EvalProvider {
  /** Identifier persisted into `skill_eval_runs.runner` for audit. */
  readonly name: string;
  run(input: string, ctx: { skillSlug: string; caseName: string }): Promise<EvalProviderResult>;
}
