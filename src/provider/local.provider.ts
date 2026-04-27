import type { ISkillProvider } from "./interface.js";
import type { IStorageProvider } from "../storage/provider.interface.js";
import type { ICacheProvider } from "../cache/provider.interface.js";
import type { SkillMeta, SkillFileContent, FileInfo, SkillStatus } from "../types/index.js";
import { SkillRepository } from "../db/repositories/skill.repository.js";
import type { SkillFileRepository } from "../db/repositories/skill-file.repository.js";
import { validateFilePath, isTextFile, getMimeType } from "../utils/security.js";
import { SkillNotFoundError } from "../utils/errors.js";

export class LocalSkillProvider implements ISkillProvider {
  constructor(
    private storage: IStorageProvider,
    private skillRepo: SkillRepository,
    private skillFileRepo: SkillFileRepository,
    private cache: ICacheProvider,
  ) {}

  async listSkills(options?: { category?: string; tags?: string[] }): Promise<SkillMeta[]> {
    return this.skillRepo.findAll({
      status: "published" as SkillStatus,
      category: options?.category,
      tags: options?.tags,
    });
  }

  async getSkillMeta(slug: string): Promise<SkillMeta | null> {
    return this.skillRepo.findBySlug(slug);
  }

  async getSkillEntry(slug: string): Promise<string> {
    const skill = await this.skillRepo.findBySlug(slug);
    if (!skill) throw new SkillNotFoundError(slug);

    const cacheKey = `skill:entry:${slug}`;
    const cached = await this.cache.get<string>(cacheKey);
    if (cached) return cached;

    const buffer = await this.storage.get(`${skill.storagePath}${skill.entryFile}`);
    if (!buffer) throw new Error(`Entry file not found: ${skill.entryFile}`);

    const content = buffer.toString("utf-8");
    await this.cache.set(cacheKey, content, 600);
    return content;
  }

  async getSkillFiles(slug: string, filePaths: string[]): Promise<SkillFileContent[]> {
    const skill = await this.skillRepo.findBySlug(slug);
    if (!skill) throw new SkillNotFoundError(slug);

    const results = await Promise.all(
      filePaths.map(async (rawPath) => {
        const path = validateFilePath(rawPath);
        const cacheKey = `skill:file:${slug}:${path}`;

        if (isTextFile(path)) {
          const cached = await this.cache.get<string>(cacheKey);
          if (cached) return { path, content: cached, encoding: "utf-8" as const };
        }

        const buffer = await this.storage.get(`${skill.storagePath}${path}`);
        if (!buffer) throw new Error(`File not found: ${path}`);

        const text = isTextFile(path);
        const content = text ? buffer.toString("utf-8") : buffer.toString("base64");
        const encoding = text ? ("utf-8" as const) : ("base64" as const);

        if (text) {
          await this.cache.set(cacheKey, content, 600);
        }

        return { path, content, encoding, mimeType: getMimeType(path) };
      }),
    );
    return results;
  }

  async getSkillFileTree(slug: string): Promise<FileInfo[]> {
    const skill = await this.skillRepo.findBySlug(slug);
    if (!skill) throw new SkillNotFoundError(slug);

    // Try DB first
    const dbFiles = await this.skillFileRepo.findBySkillId(skill.id);
    if (dbFiles.length > 0) {
      return dbFiles.map((f) => ({
        path: f.filePath,
        type: "file" as const,
        size: f.fileSize,
        mimeType: f.mimeType,
      }));
    }

    // Fallback: walk storage recursively
    const files: FileInfo[] = [];
    await this.walkDirectory(skill.storagePath, files);
    return files;
  }

  async skillExists(slug: string): Promise<boolean> {
    return this.skillRepo.exists(slug);
  }

  private async walkDirectory(storagePath: string, files: FileInfo[]): Promise<void> {
    const allPaths = await this.storage.listRecursive(storagePath.replace(/\/$/, ""));
    for (const filePath of allPaths) {
      // Convert "skills/slug/references/doc.md" → "references/doc.md"
      const relativePath = filePath.startsWith(storagePath)
        ? filePath.slice(storagePath.length)
        : filePath;

      try {
        const size = await this.storage.size(filePath);
        files.push({
          path: relativePath,
          type: "file" as const,
          size,
          mimeType: getMimeType(relativePath),
        });
      } catch {
        // Skip files that can't be stat'd
      }
    }
  }
}
