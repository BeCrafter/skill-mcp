import type { EvalProvider, EvalProviderResult, EvalInput } from "./provider.interface.js";

export interface LLMEvalProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/**
 * LLM-backed eval provider. Sends the skill entry (or pipeline instructions)
 * plus the test case input to an LLM and returns the output.
 *
 * Uses the OpenAI-compatible chat completions API format.
 */
export class LLMEvalProvider implements EvalProvider {
  readonly name: string;
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(opts: LLMEvalProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.model = opts.model ?? "gpt-4o-mini";
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.name = `llm-${this.model}`;
  }

  async run(input: EvalInput): Promise<EvalProviderResult> {
    const systemPrompt = input.pipelineInstructions
      ? `You are a pipeline executor. Follow these composed instructions:\n\n${input.pipelineInstructions}`
      : input.skillEntry
        ? `You are a skill executor. Follow these skill instructions:\n\n${input.skillEntry}`
        : "You are a helpful assistant.";

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input.input },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`LLM API error: ${res.status}`);
    }

    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    const output = data.choices?.[0]?.message?.content ?? "";

    // ponytail: tool extraction is best-effort; real implementation depends on the LLM's tool-use format
    return { output, toolsUsed: [] };
  }
}
