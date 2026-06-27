import type { EvalProvider, EvalProviderResult, EvalInput } from "./provider.interface.js";

/**
 * Degenerate provider that echoes the case input back as output.
 * Used to exercise the assertion + persistence machinery end-to-end.
 */
export class EchoEvalProvider implements EvalProvider {
  readonly name = "echo";
  async run(input: EvalInput): Promise<EvalProviderResult> {
    return { output: input.input, toolsUsed: [] };
  }
}
