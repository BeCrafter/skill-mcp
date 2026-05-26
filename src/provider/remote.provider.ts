import { z } from "zod";
import type { ISkillProvider } from "./interface.js";
import type { SkillMeta, SkillFileContent, FileInfo } from "../types/index.js";
import type { ICacheProvider } from "../cache/provider.interface.js";
import { validateFilePath } from "../utils/security.js";
import { SkillNotFoundError, UpstreamError } from "../utils/errors.js";
import { getLogger } from "../utils/logger.js";
import { metrics } from "../telemetry/metrics.js";

const logger = getLogger();

// T-605 — defensive validation of cloud-service responses. Cross-version
// schema drift (e.g. gateway v1.1 calling cloud v1.0) used to surface as a
// confusing TypeError deep in SkillService; now it fails at the boundary
// with a labelled UpstreamError and bumps a metric so dashboards catch it.
//
// The gateway endpoints return SkillMetaPublic, which omits `storagePath`
// and `contentHash` (internal storage details — see types/index.ts). The
// schema here matches that public shape; the result is cast to SkillMeta
// at the boundary because gateway-mode callers don't access those fields.
const skillMetaSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  displayName: z.string().nullable(),
  description: z.string(),
  version: z.string(),
  category: z.string().nullable(),
  tags: z.array(z.string()),
  attributes: z.record(z.unknown()),
  status: z.enum(["draft", "published", "deprecated", "archived"]),
  visibility: z.enum(["public", "private", "internal"]),
  entryFile: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).passthrough();

const fileInfoSchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory"]),
  size: z.number(),
  mimeType: z.string(),
}).passthrough();

const skillFileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(["utf-8", "base64"]),
  mimeType: z.string().optional(),
}).passthrough();

function apiResponseSchema<T extends z.ZodTypeAny>(inner: T) {
  return z.object({
    data: inner.optional(),
    success: z.boolean().optional(),
  }).passthrough();
}

function validateOrThrow<T>(method: string, schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    metrics.remoteValidationErrors.inc({ method });
    logger.warn(
      { method, issues: result.error.issues.slice(0, 5) },
      "RemoteSkillProvider rejected upstream payload that failed schema validation",
    );
    throw new UpstreamError(`Invalid response from cloud service for ${method}`);
  }
  return result.data;
}

interface FetchOptions {
  timeout?: number;
  retries?: number;
}

/** Decision returned by classifyResponse for status-code-driven retry. */
type RetryDecision =
  | { kind: "ok"; response: Response }
  | { kind: "fail-fast"; response: Response }
  | { kind: "retry"; response: Response; delayMs: number | null };

/**
 * Parse a Retry-After header value (delta-seconds or HTTP-date) into ms.
 * Returns null when the header is absent or unparseable.
 */
export function parseRetryAfter(header: string | null | undefined, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  // delta-seconds path
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  // HTTP-date path
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, parsed - now);
}

export class RemoteSkillProvider implements ISkillProvider {
  private readonly timeout: number = 10000;
  private readonly maxRetries: number = 3;
  /** Base delay for exponential backoff (ms). */
  private readonly retryBaseDelay: number = 500;
  /** Hard cap so a misbehaving Retry-After cannot stall the worker. */
  private readonly retryMaxDelay: number = 30_000;

  constructor(
    private cloudServiceUrl: string,
    private authToken: string,
    private cache: ICacheProvider,
  ) {}

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.authToken}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Status-code-driven retry policy:
   *   - 2xx / 3xx                       → ok
   *   - 4xx (except 429)                → fail-fast (don't retry; client error)
   *   - 429                             → retry, honor Retry-After
   *   - 500                             → retry once, then fail-fast
   *   - 502 / 503 / 504                 → retry with exponential backoff + jitter
   *   - other 5xx                       → retry with exponential backoff + jitter
   */
  private classifyResponse(response: Response, attempt: number): RetryDecision {
    const status = response.status;
    if (status < 400) return { kind: "ok", response };
    if (status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      return { kind: "retry", response, delayMs: retryAfter };
    }
    if (status >= 400 && status < 500) {
      return { kind: "fail-fast", response };
    }
    if (status === 500 && attempt >= 1) {
      // 500 retries once (attempt 0). On attempt >=1, fail fast — likely
      // a deterministic upstream bug, not transient.
      return { kind: "fail-fast", response };
    }
    return { kind: "retry", response, delayMs: null };
  }

  private computeBackoff(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) {
      return Math.min(retryAfterMs, this.retryMaxDelay);
    }
    // Exponential backoff with full jitter:
    //   delay = base * 2^attempt + random(0, base)
    const exp = this.retryBaseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * this.retryBaseDelay;
    return Math.min(exp + jitter, this.retryMaxDelay);
  }

  /**
   * Execute the request with timeout. Returns either a Response (which
   * `classifyResponse` then judges) or throws for transport-layer failures
   * (DNS, abort, ECONNRESET, etc.). The caller's loop decides retry.
   */
  private async executeOnce(url: string, options: RequestInit, timeout: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchWithRetry(url: string, options: RequestInit & FetchOptions): Promise<Response> {
    const { timeout = this.timeout, retries = this.maxRetries, ...fetchOptions } = options;
    let lastError: Error | null = null;
    let lastResponse: Response | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.executeOnce(url, fetchOptions, timeout);
        const decision = this.classifyResponse(response, attempt);
        if (decision.kind === "ok") return decision.response;
        if (decision.kind === "fail-fast") return decision.response;

        // retry — drain body so the connection can be reused
        lastResponse = decision.response;
        await decision.response.text().catch(() => undefined);

        if (attempt >= retries) break;
        const delay = this.computeBackoff(attempt, decision.delayMs);
        logger.warn(
          { url, attempt, status: response.status, retryIn: delay },
          "Remote provider response retryable, retrying",
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const isRetryableTransport = lastError.name === "AbortError" || error instanceof TypeError;

        if (attempt < retries && isRetryableTransport) {
          const delay = this.computeBackoff(attempt, null);
          logger.warn(
            { url, attempt, error: lastError.message, retryIn: delay },
            "Remote provider transport error, retrying",
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        throw new UpstreamError(
          `Remote request failed after ${attempt + 1} attempts: ${lastError.message}`,
          undefined,
          lastError,
        );
      }
    }

    if (lastResponse) {
      throw new UpstreamError(
        `Remote request exhausted retries (status ${lastResponse.status})`,
        lastResponse.status,
      );
    }
    throw new UpstreamError(
      `Remote request failed: ${lastError?.message ?? "unknown error"}`,
      undefined,
      lastError ?? undefined,
    );
  }

  async listSkills(options?: { category?: string; tags?: string[] }): Promise<SkillMeta[]> {
    const params = new URLSearchParams();
    if (options?.category) params.set("category", options.category);
    if (options?.tags?.length) params.set("tags", options.tags.join(","));

    const queryStr = params.toString();
    const url = `${this.cloudServiceUrl}/api/gateway/skills${queryStr ? `?${queryStr}` : ""}`;
    const resp = await this.fetchWithRetry(url, {
      headers: this.getHeaders(),
    });
    if (!resp.ok) throw new UpstreamError(`Failed to list skills: ${resp.statusText}`, resp.status);
    const raw = await resp.json();
    const data = validateOrThrow("listSkills", apiResponseSchema(z.array(skillMetaSchema)), raw);
    return (data.data ?? []) as unknown as SkillMeta[];
  }

  async getSkillMeta(slug: string): Promise<SkillMeta | null> {
    const url = `${this.cloudServiceUrl}/api/gateway/skills/${slug}`;
    const resp = await this.fetchWithRetry(url, {
      headers: this.getHeaders(),
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new UpstreamError(`Failed to get skill: ${resp.statusText}`, resp.status);
    const raw = await resp.json();
    const data = validateOrThrow("getSkillMeta", apiResponseSchema(skillMetaSchema), raw);
    return (data.data ?? null) as unknown as SkillMeta | null;
  }

  async getSkillMetaById(id: string): Promise<SkillMeta | null> {
    const url = `${this.cloudServiceUrl}/api/gateway/skills/${id}`;
    const resp = await this.fetchWithRetry(url, {
      headers: this.getHeaders(),
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new UpstreamError(`Failed to get skill by id: ${resp.statusText}`, resp.status);
    const raw = await resp.json();
    const data = validateOrThrow("getSkillMetaById", apiResponseSchema(skillMetaSchema), raw);
    return (data.data ?? null) as unknown as SkillMeta | null;
  }

  async getSkillEntry(slug: string): Promise<string> {
    const cacheKey = `skill:entry:${slug}`;
    const cached = await this.cache.get<string>(cacheKey);
    if (cached) return cached;

    const url = `${this.cloudServiceUrl}/api/gateway/skills/${slug}/entry`;
    const resp = await this.fetchWithRetry(url, {
      headers: this.getHeaders(),
    });
    if (!resp.ok) {
      if (resp.status === 404) throw new SkillNotFoundError(slug);
      throw new UpstreamError(`Failed to get skill entry: ${resp.statusText}`, resp.status);
    }
    const content = await resp.text();
    await this.cache.set(cacheKey, content, 600);
    return content;
  }

  async getSkillFiles(slug: string, filePaths: string[]): Promise<SkillFileContent[]> {
    // Validate paths locally before sending to cloud
    const safePaths = filePaths.map(p => validateFilePath(p));

    // T-729 — `safePaths.join(",")` collides if a filename contains a comma:
    // `["a,b.md"]` and `["a", "b.md"]` would map to the same cache key and
    // serve cross-request data. Use `JSON.stringify` for an unambiguous
    // serialization (preserves order; quotes commas inside strings).
    const cacheKey = `skill:files:${slug}:${JSON.stringify(safePaths)}`;
    const cached = await this.cache.get<SkillFileContent[]>(cacheKey);
    if (cached) return cached;

    const url = `${this.cloudServiceUrl}/api/gateway/skills/${slug}/files`;
    const resp = await this.fetchWithRetry(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ paths: safePaths }),
    });
    if (!resp.ok) {
      if (resp.status === 404) throw new SkillNotFoundError(slug);
      throw new UpstreamError(`Failed to get skill files: ${resp.statusText}`, resp.status);
    }
    const raw = await resp.json();
    const data = validateOrThrow("getSkillFiles", apiResponseSchema(z.array(skillFileContentSchema)), raw);
    const files = (data.data ?? []) as SkillFileContent[];
    if (files.length > 0) {
      await this.cache.set(cacheKey, files, 600);
    }
    return files;
  }

  async getSkillFileTree(slug: string): Promise<FileInfo[]> {
    const cacheKey = `skill:filetree:${slug}`;
    const cached = await this.cache.get<FileInfo[]>(cacheKey);
    if (cached) return cached;

    const url = `${this.cloudServiceUrl}/api/gateway/skills/${slug}/file-tree`;
    const resp = await this.fetchWithRetry(url, {
      headers: this.getHeaders(),
    });
    if (!resp.ok) throw new UpstreamError(`Failed to get file tree: ${resp.statusText}`, resp.status);
    const raw = await resp.json();
    const data = validateOrThrow("getSkillFileTree", apiResponseSchema(z.array(fileInfoSchema)), raw);
    const tree = (data.data ?? []) as FileInfo[];
    if (tree.length > 0) {
      await this.cache.set(cacheKey, tree, 600);
    }
    return tree;
  }

  async skillExists(identifier: string): Promise<boolean> {
    const meta = await this.resolveSkill(identifier);
    return meta !== null;
  }

  private async resolveSkill(identifier: string): Promise<SkillMeta | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    if (isUuid) {
      const byId = await this.getSkillMetaById(identifier);
      if (byId) return byId;
    }
    return this.getSkillMeta(identifier);
  }
}
