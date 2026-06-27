import type { IEmbeddingProvider } from "./embedding-provider.js";
import { getLogger } from "../utils/logger.js";
import { l2Normalize } from "./normalize.js";

const logger = getLogger();

/**
 * OpenAI embedding provider. Calls the /v1/embeddings API.
 * Default model: text-embedding-3-small (1536 dimensions).
 */
export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string; dimension?: number }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "text-embedding-3-small";
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.dimension = opts.dimension ?? 1536;
    this.name = `openai-${this.model}`;
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!text || !text.trim()) return null;
    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: text }),
      });
      if (!res.ok) { logger.warn({ status: res.status }, "OpenAI embedding failed"); return null; }
      const data = await res.json() as { data: Array<{ embedding: number[] }> };
      return data.data?.[0]?.embedding ? l2Normalize(data.data[0].embedding) : null;
    } catch (err) { logger.warn({ err }, "OpenAI embedding error"); return null; }
  }

  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    if (texts.length === 0) return [];
    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
      if (!res.ok) { logger.warn({ status: res.status }, "OpenAI batch embedding failed"); return texts.map(() => null); }
      const data = await res.json() as { data: Array<{ embedding: number[]; index: number }> };
      const result: (Float32Array | null)[] = texts.map(() => null);
      for (const item of data.data) result[item.index] = l2Normalize(item.embedding);
      return result;
    } catch (err) { logger.warn({ err }, "OpenAI batch embedding error"); return texts.map(() => null); }
  }
}
