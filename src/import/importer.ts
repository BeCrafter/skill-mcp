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

    // 5. Handle duplicate name
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
        throw new ContentUnchangedError(manifest.name);
      }
      slug = targetSkill.slug;
      storagePath = targetSkill.storagePath;
      action = "updated";
    } else if (existing.length > 0) {
      if (!options.overwrite) {
        throw new DuplicateSkillNameError(manifest.name, existing.map(s => ({ slug: s.slug, version: s.version })));
      }
      // Overwrite first match
      targetSkill = existing[0];
      if (targetSkill.contentHash === contentHash) {
        throw new ContentUnchangedError(manifest.name);
      }
      slug = targetSkill.slug;
      storagePath = targetSkill.storagePath;
      action = "updated";
    } else {
      slug = slugify(manifest.name);
      storagePath = `skills/${slug}/`;
    }

    // 6. Write files to storage
    for (const file of skillFiles) {
      await this.storage.put(`${storagePath}${file.path}`, file.buffer);
    }

    // 7. Extract description from SKILL.md frontmatter if not provided
    let description = options.description;
    if (!description && entryContent) {
      const { frontmatter } = extractFrontmatter(entryContent);
      description = (frontmatter.description as string) ?? extractDescription(entryContent);
    }

    // 8. Write/update DB
    const version = targetSkill
      ? bumpVersion(targetSkill.version, options.versionBump)
      : (manifest.version ?? "1.0.0");

    const tags = options.tags ?? (
      entryContent ? (extractFrontmatter(entryContent).frontmatter.tags as string[] ?? []) : []
    );

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

    // 9. Write/update skill_files table
    await this.skillFileRepo.deleteBySkillId(skillId);
    for (const file of skillFiles) {
      await this.skillFileRepo.create(skillId, {
        filePath: file.path,
        fileType: isTextFile(file.path) ? "text" : "binary",
        fileSize: file.buffer.length,
        mimeType: getMimeType(file.path),
      });
    }

    // 10. Clear cache for this skill only
    await this.cache.clearByPrefix(`skill:entry:${slug}`);
    await this.cache.clearByPrefix(`skill:file:${slug}`);

    this.logger.info({ slug, name: manifest.name, version, action, fileCount: skillFiles.length }, "Skill imported");

    return {
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
    if (!manifestFile) {
      throw new Error("manifest.json not found in skill files");
    }
    return JSON.parse(manifestFile.buffer.toString("utf-8"));
  }
}
