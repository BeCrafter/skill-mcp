import type { IEmbeddingProvider } from "./embedding-provider.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger();

/**
 * Ollama embedding provider. Calls the /api/embed endpoint.
 * Default model: nomic-embed-text (768 dimensions).
 */
export class OllamaEmbeddingProvider implements IEmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  private baseUrl: string;
  private model: string;

  constructor(opts: { model?: string; baseUrl?: string; dimension?: number }) {
    this.model = opts.model ?? "nomic-embed-text";
    this.baseUrl = opts.baseUrl ?? "http://localhost:11434";
    this.dimension = opts.dimension ?? 768;
    this.name = `ollama-${this.model}`;
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!text || !text.trim()) return null;
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: text }),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, "Ollama embedding failed");
        return null;
      }
      const data = await res.json() as { embeddings: number[][] };
      if (!data.embeddings?.[0]) return null;
      const vec = new Float32Array(data.embeddings[0]);
      let norm = 0;
      for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
      return vec;
    } catch (err) {
      logger.warn({ err }, "Ollama embedding error");
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    if (texts.length === 0) return [];
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, "Ollama batch embedding failed");
        return texts.map(() => null);
      }
      const data = await res.json() as { embeddings: number[][] };
      return (data.embeddings ?? []).map(emb => {
        const vec = new Float32Array(emb);
        let norm = 0;
        for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
        norm = Math.sqrt(norm);
        if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
        return vec;
      });
    } catch (err) {
      logger.warn({ err }, "Ollama batch embedding error");
      return texts.map(() => null);
    }
  }
}
