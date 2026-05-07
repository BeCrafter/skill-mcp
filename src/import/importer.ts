import type { Logger } from "pino";
import type { IStorageProvider } from "../storage/provider.interface.js";
import type { ICacheProvider } from "../cache/provider.interface.js";
import type { SkillRepository } from "../db/repositories/skill.repository.js";
import type { SkillFileRepository } from "../db/repositories/skill-file.repository.js";
import type { SkillVersionRepository } from "../db/repositories/skill-version.repository.js";
import type { ImportOptions, ImportResult, SkillFileInput, SkillFrontmatter, SkillMeta } from "../types/index.js";
import type { DomainEventBus } from "../events/event-bus.js";
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
    private eventBus?: DomainEventBus,
    private versionRepo?: SkillVersionRepository,
  ) {}

  async import(source: string, options: ImportOptions): Promise<ImportResult> {
    this.logger.info({ source, options }, "Importing skill package");

    // 1. Resolve source
    const skillFiles = await this.resolveSource(source, options);
    this.logger.info({ fileCount: skillFiles.length }, "Files resolved");

    // 2. Parse SKILL.md frontmatter
    let meta: SkillFrontmatter;
    try {
      if (source.startsWith("http") || source.startsWith("git@")) {
        meta = this.parseFrontmatterFromFiles(skillFiles);
      } else {
        meta = this.localSource.parseSkillMeta(source);
      }
    } catch (error) {
      throw new InvalidManifestError((error as Error).message);
    }

    // 3. Validate
    const entryFile = skillFiles.find(f => f.path === (meta.entry ?? "SKILL.md"));
    const entryContent = entryFile ? entryFile.buffer.toString("utf-8") : null;
    const validation = validateSkillPackage(meta, entryContent);
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
    const existing = await this.skillRepo.findByName(meta.name);
    let targetSkill = null;
    let slug: string;
    let storagePath: string;
    let action: "created" | "updated" = "created";

    if (options.targetId) {
      targetSkill = await this.skillRepo.findById(options.targetId);
      if (!targetSkill || targetSkill.name !== meta.name) {
        throw new SkillNotFoundError(options.targetId);
      }
      if (targetSkill.contentHash === contentHash) {
        if (this.shouldUpdateMetadata(targetSkill, options, tags, description)) {
          await this.updateMetadata(targetSkill, options, tags, targetSkill.slug);
          this.logger.info({ slug: targetSkill.slug, name: meta.name }, "Skill metadata updated (content unchanged)");
          return {
            id: targetSkill.id,
            slug: targetSkill.slug,
            name: meta.name,
            version: targetSkill.version,
            fileCount: skillFiles.length,
            category: options.category ?? targetSkill.category ?? undefined,
            tags: options.tags ?? (targetSkill.tags as string[] ?? []),
            action: "updated",
          };
        }
        throw new ContentUnchangedError(meta.name);
      }
      slug = targetSkill.slug;
      storagePath = targetSkill.storagePath;
      action = "updated";
    } else if (existing.length > 0) {
      if (options.allowDuplicate) {
        slug = await this.uniqueSlug(slugify(meta.name));
        storagePath = `${slug}/`;
      } else if (!options.overwrite) {
        throw new DuplicateSkillNameError(meta.name, existing.map(s => ({ slug: s.slug, version: s.version })));
      } else {
        // Overwrite first match
        targetSkill = existing[0];
        if (targetSkill.contentHash === contentHash) {
          if (this.shouldUpdateMetadata(targetSkill, options, tags, description)) {
            await this.updateMetadata(targetSkill, options, tags, existing[0].slug);
            this.logger.info({ slug: existing[0].slug, name: meta.name }, "Skill metadata updated (content unchanged)");
            return {
              id: existing[0].id,
              slug: existing[0].slug,
              name: meta.name,
              version: targetSkill.version,
              fileCount: skillFiles.length,
              category: options.category ?? targetSkill.category ?? undefined,
              tags: options.tags ?? (targetSkill.tags as string[] ?? []),
              action: "updated",
            };
          }
          throw new ContentUnchangedError(meta.name);
        }
        slug = targetSkill.slug;
        storagePath = targetSkill.storagePath;
        action = "updated";
      }
    } else {
      slug = slugify(meta.name);
      storagePath = `${slug}/`;
    }

    for (const file of skillFiles) {
      await this.storage.put(`${storagePath}${file.path}`, file.buffer);
    }

    const version = targetSkill
      ? bumpVersion(targetSkill.version, options.versionBump)
      : (meta.version ?? "1.0.0");

    let skillId: string;

    if (action === "updated" && targetSkill) {
      // Snapshot current version before update
      await this.snapshotCurrentVersion(targetSkill);

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
        name: meta.name,
        description: description ?? "",
        version,
        category: options.category,
        tags,
        contentHash,
        storagePath,
        status: "published",
        entryFile: meta.entry ?? "SKILL.md",
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

    this.eventBus?.publish({ type: "skill:imported", slug });

    this.logger.info({ slug, name: meta.name, version, action, fileCount: skillFiles.length }, "Skill imported");

    return {
      id: skillId,
      slug,
      name: meta.name,
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

  private parseFrontmatterFromFiles(files: SkillFileInput[]): SkillFrontmatter {
    const skillFile = files.find(f => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md"));
    if (!skillFile) {
      throw new Error("SKILL.md not found in skill files");
    }

    const { frontmatter } = extractFrontmatter(skillFile.buffer.toString("utf-8"));
    const name = frontmatter["name"];
    if (!name || typeof name !== "string") {
      throw new Error("name is required in SKILL.md frontmatter");
    }

    return {
      name: name as string,
      version: (frontmatter["version"] as string) ?? undefined,
      description: (frontmatter["description"] as string) ?? undefined,
      entry: (frontmatter["entry"] as string) ?? "SKILL.md",
      files: frontmatter["files"] as string[] | undefined,
      tags: frontmatter["tags"] as string[] | undefined,
      category: (frontmatter["category"] as string) ?? undefined,
    };
  }

  private shouldUpdateMetadata(
    targetSkill: { category: string | null; tags: unknown; description: string | null },
    options: ImportOptions,
    tags: string[],
    _description: string | null | undefined,
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
    this.eventBus?.publish({ type: "skill:updated", slug });
  }

  private async uniqueSlug(base: string): Promise<string> {
    if (!await this.skillRepo.findBySlug(base)) return base;
    let counter = 2;
    while (await this.skillRepo.findBySlug(`${base}-${counter}`)) {
      counter++;
    }
    return `${base}-${counter}`;
  }

  private async snapshotCurrentVersion(skill: SkillMeta): Promise<void> {
    if (!this.versionRepo) return;

    const versionPath = `${skill.storagePath}.versions/${skill.version}/`;

    try {
      // List files in current skill directory (excluding .versions subdir)
      const files = await this.storage.listRecursive(skill.storagePath);
      let fileCount = 0;

      for (const filePath of files) {
        if (!filePath.startsWith(".versions/")) {
          const content = await this.storage.get(`${skill.storagePath}${filePath}`);
          if (content) {
            await this.storage.put(`${versionPath}${filePath}`, content);
            fileCount++;
          }
        }
      }

      // Record version in database
      this.versionRepo.create({
        skillId: skill.id,
        version: skill.version,
        contentHash: skill.contentHash!,
        storagePath: versionPath,
        entryFile: skill.entryFile,
        fileCount,
      });

      this.logger.debug({ skillId: skill.id, version: skill.version, fileCount }, "Version snapshot created");
    } catch (error) {
      this.logger.warn({ error, skillId: skill.id, version: skill.version }, "Failed to snapshot version");
    }
  }
}
