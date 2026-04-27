import type { ISkillProvider } from "./interface.js";
import type { SkillMeta, SkillFileContent, FileInfo } from "../types/index.js";
import type { ICacheProvider } from "../cache/provider.interface.js";
import { validateFilePath } from "../utils/security.js";
import { SkillNotFoundError } from "../utils/errors.js";

interface ApiResponse<T> {
  data?: T;
  success?: boolean;
}

export class RemoteSkillProvider implements ISkillProvider {
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

  async listSkills(options?: { category?: string; tags?: string[] }): Promise<SkillMeta[]> {
    const params = new URLSearchParams();
    if (options?.category) params.set("category", options.category);
    if (options?.tags?.length) params.set("tags", options.tags.join(","));

    const queryStr = params.toString();
    const url = `${this.cloudServiceUrl}/api/skills${queryStr ? `?${queryStr}` : ""}`;
    const resp = await fetch(url, {
      headers: this.getHeaders(),
    });
    if (!resp.ok) throw new Error(`Failed to list skills: ${resp.statusText}`);
    const data = (await resp.json()) as ApiResponse<SkillMeta[]>;
    return data.data ?? [];
  }

  async getSkillMeta(slug: string): Promise<SkillMeta | null> {
    const resp = await fetch(`${this.cloudServiceUrl}/api/skills/${slug}`, {
      headers: this.getHeaders(),
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Failed to get skill: ${resp.statusText}`);
    const data = (await resp.json()) as ApiResponse<SkillMeta>;
    return data.data ?? null;
  }

  async getSkillEntry(slug: string): Promise<string> {
    const cacheKey = `skill:entry:${slug}`;
    const cached = await this.cache.get<string>(cacheKey);
    if (cached) return cached;

    const resp = await fetch(`${this.cloudServiceUrl}/api/skills/${slug}/entry`, {
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

    const resp = await fetch(`${this.cloudServiceUrl}/api/skills/${slug}/files`, {
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

    const resp = await fetch(`${this.cloudServiceUrl}/api/skills/${slug}/file-tree`, {
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

  async skillExists(slug: string): Promise<boolean> {
    const meta = await this.getSkillMeta(slug);
    return meta !== null;
  }
}
