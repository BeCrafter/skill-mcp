/**
 * P1-11 stage 3 — pluggable embedding provider contract.
 *
 * The `IEmbeddingProvider` interface decouples SkillSearchService from a
 * specific embedding model. Production deployments wire in a real provider
 * (OpenAI / Ollama / a locally-hosted model); the open-source default ships
 * `NullEmbeddingProvider` which short-circuits the vector path so the core
 * project has no implicit network or model dependency.
 *
 * `HashEmbeddingProvider` is a deterministic stand-in for tests and offline
 * dev: it produces stable 384-dim L2-normalized vectors purely from the input
 * text via a hash → splay-into-frequencies routine. Two equal inputs always
 * map to the same vector; two semantically related inputs DO NOT necessarily
 * land near each other (it's a hash, not a model). It's useful for proving
 * the wiring round-trips end-to-end without committing the project to a
 * specific embedding API.
 *
 * Key contract notes:
 *  - `dimension` is fixed for the lifetime of the provider — the storage
 *    layer asserts `vector.length === dimension` on every upsert so a model
 *    swap raises rather than silently corrupting cosine math.
 *  - `embed()` MAY return `null` to mean "no embedding available for this
 *    text" (empty input, model not loaded yet, transient error). Callers
 *    must treat null as "skip vector indexing" rather than crashing.
 *  - `embedBatch()` returns one slot per input in input order; nulls are
 *    placed in the corresponding slot. This lets callers zip results back
 *    with their input ids without a second lookup.
 *  - Vectors returned MUST be L2-normalized (sum of squares = 1, within
 *    float epsilon). `VectorIndex` and the hybrid scorer assume this so they
 *    can use a plain dot product as cosine similarity.
 */

export interface IEmbeddingProvider {
  /** Stable identifier — written into `skill_embeddings.model_name` so a
   *  later model swap can detect stale rows and trigger re-embedding. */
  readonly name: string;
  /** Vector dimension. Fixed per provider instance. */
  readonly dimension: number;

  /** Compute one embedding. Return null when the provider can't / shouldn't
   *  emit a vector for this text (empty / unsupported / transient failure). */
  embed(text: string): Promise<Float32Array | null>;

  /** Batch variant. Default impl loops `embed()` so tiny providers don't
   *  need to override; real providers should override to leverage the
   *  upstream API's batch endpoint. Slots line up 1:1 with inputs. */
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
}

/**
 * No-op provider. Returns null for every input so `SkillSearchService`
 * skips vector indexing entirely. This is the production default for the
 * open-source distribution: hybrid search works only when an operator has
 * explicitly wired in a real embedding provider, so we don't ship surprise
 * latency/cost in the core. `name` is "null" so any persisted rows from a
 * previous run with a real provider are recognised as stale and dropped.
 */
export class NullEmbeddingProvider implements IEmbeddingProvider {
  readonly name = "null";
  readonly dimension = 0;

  async embed(_text: string): Promise<Float32Array | null> {
    return null;
  }

  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    return texts.map(() => null);
  }
}

/**
 * Deterministic hash-based stand-in. Maps text → 384-dim vector via:
 *   1. tokenize the same way BM25 does (so empty / whitespace inputs
 *      collapse to null, matching real-provider behaviour);
 *   2. for each token, hash it into the 384 buckets and accumulate
 *      term-frequency-style weights;
 *   3. L2-normalize the bucket vector.
 *
 * Two identical strings always yield the same vector (deterministic).
 * Strings that share tokens land near each other in cosine space (so
 * "ripgrep search" and "search ripgrep" are similar), but unrelated
 * strings that happen to share a hash bucket will get false-positive
 * similarity. This is intentional — the goal is to exercise the storage
 * + hybrid-scoring path, not to actually do semantic search.
 *
 * Production users replace this with a real provider via DI.
 */
export class HashEmbeddingProvider implements IEmbeddingProvider {
  readonly name: string;
  readonly dimension: number;

  constructor(opts: { name?: string; dimension?: number } = {}) {
    this.name = opts.name ?? "hash-stub";
    this.dimension = opts.dimension ?? 384;
    if (this.dimension < 8 || this.dimension > 4096) {
      throw new Error(`HashEmbeddingProvider: dimension out of range (${this.dimension})`);
    }
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!text || !text.trim()) return null;
    const tokens = text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 0);
    if (tokens.length === 0) return null;

    const vec = new Float32Array(this.dimension);
    for (const token of tokens) {
      // Two hash slots per token so a token influences both magnitude and
      // sign distribution — keeps the resulting vector from being trivially
      // sparse for short inputs. fnv1a is cheap, deterministic, dependency-free.
      const h1 = fnv1a(token) % this.dimension;
      const h2 = fnv1a(`~${token}`) % this.dimension;
      vec[h1] += 1;
      vec[h2] += 0.5;
    }

    let norm = 0;
    for (let i = 0; i < vec.length; i += 1) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm === 0) return null;
    for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
    return vec;
  }

  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/** FNV-1a 32-bit. Pure function, no allocation per call. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
