import type { ISkillProvider } from "./interface.js";
import type { SkillMeta, SkillFileContent, FileInfo } from "../types/index.js";
import type { ICacheProvider } from "../cache/provider.interface.js";
import { validateFilePath } from "../utils/security.js";
import { SkillNotFoundError } from "../utils/errors.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger();

interface ApiResponse<T> {
  data?: T;
  success?: boolean;
}

interface FetchOptions {
  timeout?: number;
  retries?: number;
}

export class RemoteSkillProvider implements ISkillProvider {
  private readonly timeout: number = 10000;
  private readonly maxRetries: number = 3;
  private readonly retryDelay: number = 500;

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

  private async fetchWithRetry(url: string, options: RequestInit & FetchOptions): Promise<Response> {
    const { timeout = this.timeout, retries = this.maxRetries, ...fetchOptions } = options;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url, {
          ...fetchOptions,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const isRetryable = lastError.name === "AbortError" || error instanceof TypeError;

        if (attempt < retries && isRetryable) {
          logger.warn(
            { url, attempt, error: lastError.message, retryIn: this.retryDelay },
            "Remote provider request failed, retrying",
          );
          await new Promise(resolve => setTimeout(resolve, this.retryDelay * (attempt + 1)));
          continue;
        }

        throw lastError;
      }
    }

    throw lastError || new Error("Unknown error");
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
    if (!resp.ok) throw new Error(`Failed to list skills: ${resp.statusText}`);
    const data = (await resp.json()) as ApiResponse<SkillMeta[]>;
    return data.data ?? [];
  }

  async getSkillMeta(slug: string): Promise<SkillMeta | null> {
    const url = `${this.cloudServiceUrl}/api/gateway/skills/${slug}`;
    const resp = await this.fetchWithRetry(url, {
      headers: this.getHeaders(),
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Failed to get skill: ${resp.statusText}`);
    const data = (await resp.json()) as ApiResponse<SkillMeta>;
    return data.data ?? null;
  }

  async getSkillMetaById(id: string): Promise<SkillMeta | null> {
    const url = `${this.cloudServiceUrl}/api/gateway/skills/${id}`;
    const resp = await this.fetchWithRetry(url, {
      headers: this.getHeaders(),
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Failed to get skill by id: ${resp.statusText}`);
    const data = (await resp.json()) as ApiResponse<SkillMeta>;
    return data.data ?? null;
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
      throw new Error(`Failed to get skill entry: ${resp.statusText}`);
    }
    const content = await resp.text();
    await this.cache.set(cacheKey, content, 600);
    return content;
  }

  async getSkillFiles(slug: string, filePaths: string[]): Promise<SkillFileContent[]> {
    // Validate paths locally before sending to cloud
    const safePaths = filePaths.map(p => validateFilePath(p));

    const cacheKey = `skill:files:${slug}:${safePaths.join(",")}`;
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
      throw new Error(`Failed to get skill files: ${resp.statusText}`);
    }
    const data = (await resp.json()) as ApiResponse<SkillFileContent[]>;
    const files = data.data ?? [];
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
    if (!resp.ok) throw new Error(`Failed to get file tree: ${resp.statusText}`);
    const data = (await resp.json()) as ApiResponse<FileInfo[]>;
    const tree = data.data ?? [];
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
