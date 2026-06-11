import type { EvalProvider, EvalProviderResult } from "./provider.interface.js";

/**
 * P1-12 stage 2 — degenerate provider that echoes the case input back as
 * output and reports an empty tool list. The point of this provider isn't to
 * be a useful agent — it's to prove the assertion + persistence machinery
 * end-to-end before stage 3 wires in real LLMs.
 *
 * Concretely, it lets a skill author write a case like:
 *   - input: "find foo"
 *     expected_output_contains: ["find foo"]
 * and watch the runner persist a `pass` row, OR write
 *   - input: "find foo"
 *     expected_tools: ["search"]
 * and watch it persist a `fail` row (no tools called by the echo provider).
 */
export class EchoEvalProvider implements EvalProvider {
  readonly name = "echo";
  async run(input: string): Promise<EvalProviderResult> {
    return { output: input, toolsUsed: [] };
  }
}
