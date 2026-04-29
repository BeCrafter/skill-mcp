import type { Logger } from "pino";
import type { IStorageProvider } from "../storage/provider.interface.js";
import type { ICacheProvider } from "../cache/provider.interface.js";
import type { SkillRepository } from "../db/repositories/skill.repository.js";
import type { SkillFileRepository } from "../db/repositories/skill-file.repository.js";
import type { ImportOptions, ImportResult, SkillFileInput } from "../types/index.js";
import { LocalSourceResolver } from "./local-source.js";
import { GitSourceResolver } from "./git-source.js";
import { validateSkillPackage } from "./validator.js";
import { computeContentHash, slugify, extractFrontmatter, extractDescription } from "../utils/manifest.js";
import { bumpVersion } from "../db/repositories/skill.repository.js";
import { isTextFile, getMimeType } from "../utils/security.js";
import {
  DuplicateSkillNameError,
  SecurityError,
  InvalidManifestError,
  ContentUnchangedError,
  SkillNotFoundError,
} from "../utils/errors.js";

export class SkillImporter {
  private localSource = new LocalSourceResolver();
  private gitSource = new GitSourceResolver();

  constructor(
    private storage: IStorageProvider,
    private skillRepo: SkillRepository,
    private skillFileRepo: SkillFileRepository,
    private cache: ICacheProvider,
    private logger: Logger,
  ) {}

  async import(source: string, options: ImportOptions): Promise<ImportResult> {
    this.logger.info({ source, options }, "Importing skill package");

    // 1. Resolve source
    const skillFiles = await this.resolveSource(source, options);
    this.logger.info({ fileCount: skillFiles.length }, "Files resolved");

    // 2. Parse manifest
    let manifest;
    try {
      if (source.startsWith("http") || source.startsWith("git@")) {
        manifest = this.parseManifestFromFiles(skillFiles);
      } else {
        manifest = this.localSource.parseManifest(source);
      }
    } catch (error) {
      throw new InvalidManifestError((error as Error).message);
    }

    // 3. Validate
    const entryFile = skillFiles.find(f => f.path === (manifest.entry ?? "SKILL.md"));
    const entryContent = entryFile ? entryFile.buffer.toString("utf-8") : null;
    const validation = validateSkillPackage(manifest, entryContent);
    if (!validation.valid) {
      if (validation.scanResult && !validation.scanResult.safe) {
        throw new SecurityError(validation.scanResult.issues);
      }
      throw new InvalidManifestError(validation.errors.join("; "));
    }

    // 4. Compute content hash
    const contentHash = computeContentHash(skillFiles);

    // 5. Extract description and tags from options or SKILL.md frontmatter
    let description = options.description;
    if (!description && entryContent) {
      const { frontmatter } = extractFrontmatter(entryContent);
      description = (frontmatter.description as string) ?? extractDescription(entryContent);
    }

    const tags = options.tags ?? (
      entryContent ? (extractFrontmatter(entryContent).frontmatter.tags as string[] ?? []) : []
    );

    // 6. Handle duplicate name
    const existing = await this.skillRepo.findByName(manifest.name);
    let targetSkill = null;
    let slug: string;
    let storagePath: string;
    let action: "created" | "updated" = "created";

    if (options.targetId) {
      targetSkill = await this.skillRepo.findById(options.targetId);
      if (!targetSkill || targetSkill.name !== manifest.name) {
        throw new SkillNotFoundError(options.targetId);
      }
      if (targetSkill.contentHash === contentHash) {
        if (this.shouldUpdateMetadata(targetSkill, options, tags, description)) {
          await this.updateMetadata(targetSkill, options, tags, targetSkill.slug);
          this.logger.info({ slug: targetSkill.slug, name: manifest.name }, "Skill metadata updated (content unchanged)");
          return {
            id: targetSkill.id,
            slug: targetSkill.slug,
            name: manifest.name,
            version: targetSkill.version,
            fileCount: skillFiles.length,
            category: options.category ?? targetSkill.category ?? undefined,
            tags: options.tags ?? (targetSkill.tags as string[] ?? []),
            action: "updated",
          };
        }
        throw new ContentUnchangedError(manifest.name);
      }
      slug = targetSkill.slug;
      storagePath = targetSkill.storagePath;
      action = "updated";
    } else if (existing.length >0) {
      if (!options.overwrite) {
        throw new DuplicateSkillNameError(manifest.name, existing.map(s => ({ slug: s.slug, version: s.version })));
      }
      // Overwrite first match
      targetSkill = existing[0];
      if (targetSkill.contentHash === contentHash) {
        if (this.shouldUpdateMetadata(targetSkill, options, tags, description)) {
          await this.updateMetadata(targetSkill, options, tags, existing[0].slug);
          this.logger.info({ slug: existing[0].slug, name: manifest.name }, "Skill metadata updated (content unchanged)");
          return {
            id: existing[0].id,
            slug: existing[0].slug,
            name: manifest.name,
            version: targetSkill.version,
            fileCount: skillFiles.length,
            category: options.category ?? targetSkill.category ?? undefined,
            tags: options.tags ?? (targetSkill.tags as string[] ?? []),
            action: "updated",
          };
        }
        throw new ContentUnchangedError(manifest.name);
      }
      slug = targetSkill.slug;
      storagePath = targetSkill.storagePath;
      action = "updated";
    } else {
      slug = slugify(manifest.name);
      storagePath = `${slug}/`;
    }

    for (const file of skillFiles) {
      await this.storage.put(`${storagePath}${file.path}`, file.buffer);
    }

    const version = targetSkill
      ? bumpVersion(targetSkill.version, options.versionBump)
      : (manifest.version ?? "1.0.0");

    let skillId: string;

    if (action === "updated" && targetSkill) {
      await this.skillRepo.update(targetSkill.id, {
        description: description ?? targetSkill.description,
        version,
        category: options.category ?? targetSkill.category,
        tags,
        contentHash,
        storagePath,
        status: "published",
      });
      skillId = targetSkill.id;
    } else {
      const created = await this.skillRepo.create({
        slug,
        name: manifest.name,
        description: description ?? "",
        version,
        category: options.category,
        tags,
        contentHash,
        storagePath,
        status: "published",
        entryFile: manifest.entry ?? "SKILL.md",
      });
      skillId = created.id;
    }

    await this.skillFileRepo.deleteBySkillId(skillId);
    for (const file of skillFiles) {
      await this.skillFileRepo.create(skillId, {
        filePath: file.path,
        fileType: isTextFile(file.path) ? "text" : "binary",
        fileSize: file.buffer.length,
        mimeType: getMimeType(file.path),
      });
    }

    await this.cache.clearByPrefix(`skill:entry:${slug}`);
    await this.cache.clearByPrefix(`skill:file:${slug}`);

    this.logger.info({ slug, name: manifest.name, version, action, fileCount: skillFiles.length }, "Skill imported");

    return {
      id: skillId,
      slug,
      name: manifest.name,
      version,
      fileCount: skillFiles.length,
      category: options.category,
      tags,
      action,
    };
  }

  private async resolveSource(source: string, options: ImportOptions): Promise<SkillFileInput[]> {
    if (source.startsWith("http") || source.startsWith("git@")) {
      return this.gitSource.resolve(source, {
        branch: options.branch,
        subDir: options.subDir,
      });
    }
    return this.localSource.resolve(source);
  }

  private parseManifestFromFiles(files: SkillFileInput[]): { name: string; version?: string; entry?: string; files?: string[] } {
    const manifestFile = files.find(f => f.path === "manifest.json");
    if (manifestFile) {
      return JSON.parse(manifestFile.buffer.toString("utf-8"));
    }

    const skillFile = files.find(f => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md"));
    if (!skillFile) {
      throw new Error("Neither manifest.json nor SKILL.md found in skill files");
    }

    const { frontmatter } = extractFrontmatter(skillFile.buffer.toString("utf-8"));
    const name = frontmatter["name"];
    if (!name || typeof name !== "string") {
      throw new Error("name is required in SKILL.md frontmatter or manifest.json");
    }

    return {
      name: name as string,
      version: (frontmatter["version"] as string) ?? undefined,
      entry: "SKILL.md",
      files: undefined,
    };
  }

  private shouldUpdateMetadata(
    targetSkill: { category: string | null; tags: unknown; description: string | null },
    options: ImportOptions,
    tags: string[],
    description: string | null | undefined,
  ): boolean {
    if (options.category !== undefined && options.category !== targetSkill.category) return true;
    if (options.tags !== undefined) {
      const currentTags = (targetSkill.tags as string[]) ?? [];
      if (JSON.stringify(currentTags.sort()) !== JSON.stringify([...tags].sort())) return true;
    }
    if (options.description !== undefined && options.description !== (targetSkill.description ?? "")) return true;
    return false;
  }

  private async updateMetadata(
    targetSkill: { id: string; slug: string; category: string | null; tags: unknown; description: string | null },
    options: ImportOptions,
    tags: string[],
    slug: string,
  ): Promise<void> {
    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    if (options.category !== undefined) updates.category = options.category;
    if (options.tags !== undefined) updates.tags = tags;
    if (options.description !== undefined) updates.description = options.description ?? null;
    await this.skillRepo.update(targetSkill.id, updates);
    await this.cache.clearByPrefix(`skill:entry:${slug}`);
    await this.cache.clearByPrefix(`skill:file:${slug}`);
  }
}
