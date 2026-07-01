import type { Logger } from "pino";
import { shortId } from "../utils/id.js";
import type { IStorageProvider } from "../storage/provider.interface.js";
import type { ICacheProvider } from "../cache/provider.interface.js";
import type { SkillRepository } from "../db/repositories/skill.repository.js";
import type { SkillFileRepository } from "../db/repositories/skill-file.repository.js";
import type { SkillVersionRepository } from "../db/repositories/skill-version.repository.js";
import type { SkillEvalRepository } from "../db/repositories/skill-eval.repository.js";
import type { ImportOptions, ImportResult, SkillFileInput, SkillFrontmatter, SkillMeta, SkillRetrievalMeta } from "../types/index.js";

/**
 * better-sqlite3 throws errors with shape `{ code: "SQLITE_CONSTRAINT_UNIQUE", ... }`
 * for UNIQUE-index violations. drizzle wraps and rethrows them, but the
 * underlying cause keeps the same code. We treat any of these shapes as a
 * UNIQUE conflict so the caller can pick a recovery path.
 */
function classifyImportError(err: unknown): "validation" | "storage" | "db" | "unknown" {
  if (err instanceof InvalidManifestError || err instanceof SecurityError) return "validation";
  if (err instanceof DuplicateSkillNameError || err instanceof SlugConflictError || err instanceof ContentUnchangedError) return "validation";
  if (isUniqueConstraintError(err)) return "db";
  const msg = err && typeof err === "object" && "message" in err ? String((err as { message?: unknown }).message ?? "") : "";
  if (/storage|put|moveDir|fs\.|ENOENT|EACCES/i.test(msg)) return "storage";
  return "unknown";
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  if (e.code === "SQLITE_CONSTRAINT_UNIQUE" || e.code === "SQLITE_CONSTRAINT") return true;
  if (e.cause?.code === "SQLITE_CONSTRAINT_UNIQUE" || e.cause?.code === "SQLITE_CONSTRAINT") return true;
  return typeof e.message === "string" && /UNIQUE constraint failed/i.test(e.message);
}
import type { DomainEventBus } from "../events/event-bus.js";
import type { UsageMeterService } from "../services/usage-meter.service.js";
import { LocalSourceResolver } from "./local-source.js";
import { GitSourceResolver } from "./git-source.js";
import { validateSkillPackage } from "./validator.js";
import { computeContentHash, slugify, extractFrontmatter, extractDescription, validateSkillMetaFields, parseEvalCases } from "../utils/manifest.js";
import { bumpVersion } from "../db/repositories/skill.repository.js";
import { isTextFile, getMimeType } from "../utils/security.js";
import { pMap } from "../utils/concurrency.js";
import { metrics } from "../telemetry/metrics.js";

const STORAGE_CONCURRENCY = 8;
const STAGING_ROOT = "__staging__";

/** Extract import source metadata from source string and options */
function extractImportSource(source: string, options: ImportOptions): {
  importSource: string;
  importUrl: string | null;
  importBranch: string | null;
  importSubDir: string | null;
} {
  const isGit = source.startsWith("http") || source.startsWith("git@");
  return {
    importSource: isGit ? "git" : "local",
    importUrl: isGit ? source : null,
    importBranch: isGit ? (options.branch ?? "main") : null,
    importSubDir: options.subDir ?? null,
  };
}

/**
 * P1-11 stage 2a — Project the validated frontmatter retrieval signals into
 * the persisted JSON envelope. Returns `null` when none of the three optional
 * fields is populated; the repo treats null and the empty-shape `{}` the
 * same way (column stays NULL).
 */
function buildRetrievalMeta(meta: SkillFrontmatter): SkillRetrievalMeta | null {
  const triggers = Array.isArray(meta.triggers) ? meta.triggers.filter(t => typeof t === "string" && t.length > 0) : [];
  const whenToUse = typeof meta.whenToUse === "string" ? meta.whenToUse.trim() : "";
  const embeddingText = typeof meta.embeddingText === "string" ? meta.embeddingText.trim() : "";
  if (triggers.length === 0 && !whenToUse && !embeddingText) return null;
  const out: SkillRetrievalMeta = {};
  if (triggers.length > 0) out.triggers = triggers;
  if (whenToUse) out.whenToUse = whenToUse;
  if (embeddingText) out.embeddingText = embeddingText;
  return out;
}
import {
  DuplicateSkillNameError,
  SecurityError,
  InvalidManifestError,
  ContentUnchangedError,
  SkillNotFoundError,
  SlugConflictError,
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
    private usageMeter?: UsageMeterService,
    /**
     * P1-12 stage 2 — optional. When wired, the importer persists the
     * stage-1-validated `eval_cases:` frontmatter into `skill_eval_cases`
     * after the skill row + file rows commit. Left unset in tests / contexts
     * that don't need eval support so we don't have to update every call site.
     */
    private evalRepo?: SkillEvalRepository,
    private enableInjectionScan: boolean = true,
  ) {}

  async import(source: string, options: ImportOptions): Promise<ImportResult> {
    const sourceLabel = source.startsWith("http") || source.startsWith("git@") ? "git" : "local";
    const end = metrics.importDuration.startTimer({ source: sourceLabel });
    try {
      const result = await this.importInner(source, options);
      end({ status: "ok" });
      return result;
    } catch (err) {
      end({ status: "error" });
      metrics.importFailures.inc({ source: sourceLabel, reason: classifyImportError(err) });
      throw err;
    }
  }

  private async importInner(source: string, options: ImportOptions): Promise<ImportResult> {
    this.logger.info({ source, options }, "Importing skill package");

    // Extract import source metadata
    const importMeta = extractImportSource(source, options);

    // 1. Resolve source
    const skillFiles = await this.resolveSource(source, options);
    this.logger.info({ fileCount: skillFiles.length }, "Files resolved");

    // 2. Parse SKILL.md frontmatter
    let meta: SkillFrontmatter;
    try {
      if (source.startsWith("http") || source.startsWith("git@")) {
        meta = this.parseFrontmatterFromFiles(skillFiles);
        // T-722 — git/http path doesn't have a local dirPath for the
        // entry-existence check (handled later via skillFiles lookup), but
        // it must still enforce T-705 field caps and tag-array shape;
        // otherwise a malicious git repo bypasses every cap and pushes
        // multi-MB strings / non-string tags into SQLite and listing APIs.
        validateSkillMetaFields(meta);
      } else {
        meta = this.localSource.parseSkillMeta(source);
      }
    } catch (error) {
      throw new InvalidManifestError((error as Error).message);
    }

    // 3. Validate
    const entryFile = skillFiles.find(f => f.path === (meta.entry ?? "SKILL.md"));
    const entryContent = entryFile ? entryFile.buffer.toString("utf-8") : null;
    const validation = validateSkillPackage(meta, entryContent, this.enableInjectionScan);
    if (!validation.valid) {
      if (validation.scanResult && !validation.scanResult.safe) {
        throw new SecurityError(validation.scanResult.issues);
      }
      throw new InvalidManifestError(validation.errors.join("; "));
    }
    // P1-21 — surface manifest_schema deprecation nudges so operators see
    // them in import logs even when validation otherwise passes.
    for (const w of validation.warnings) {
      this.logger.warn({ skill: meta.name, schema: validation.resolvedSchema }, w);
    }

    // 4. Compute content hash
    const contentHash = computeContentHash(skillFiles);

    // P1-11 stage 2a — derive the retrieval-signal envelope from the
    // (already-validated) frontmatter. Only pass it on if at least one of
    // the three optional fields is populated; the repo treats empty as null
    // so legacy rows without these fields stay clean.
    const retrievalMeta = buildRetrievalMeta(meta);

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
        if (options.slug) {
          if (await this.skillRepo.findBySlug(options.slug)) {
            throw new SlugConflictError(options.slug);
          }
          slug = options.slug;
        } else {
          slug = await this.uniqueSlug(slugify(meta.name));
        }
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
      if (options.slug) {
        if (await this.skillRepo.findBySlug(options.slug)) {
          throw new SlugConflictError(options.slug);
        }
        slug = options.slug;
      } else {
        slug = slugify(meta.name);
      }
      storagePath = `${slug}/`;
    }

    const version = targetSkill
      ? bumpVersion(targetSkill.version, options.versionBump)
      : (meta.version ?? "1.0.0");

    const importId = shortId();
    const stagingPath = `${STAGING_ROOT}/${importId}/`;
    const baseSlug = slug;

    let skillId: string;
    let createdSkillId: string | null = null;
    let storageCommitted = false;
    let recoveredWinner: SkillMeta | null = null;
    // Snapshot of the skill row prior to the update DB-write. If the storage
    // commit (or any subsequent step) throws, the catch block uses this to
    // restore the row to its pre-update state — without this, the live skill
    // row advertises a new contentHash/version while storage still holds the
    // old bytes, leaving every gateway read serving stale or mixed content.
    let preUpdateSnapshot: SkillMeta | null = null;

    try {
      // 1. Stage all files into a per-import scratch directory. Any failure
      //    here leaves only staging files behind, which the finally block
      //    cleans up — final storage path remains untouched.
      await pMap(skillFiles, STORAGE_CONCURRENCY, (file) =>
        this.storage.put(`${stagingPath}${file.path}`, file.buffer),
      );

      // 2. Snapshot the current version *before* we overwrite final storage.
      //    Reading from the still-pristine `targetSkill.storagePath` is what
      //    gives the rollback feature historical content to restore.
      if (action === "updated" && targetSkill) {
        await this.snapshotCurrentVersion(targetSkill);
      }

      // 3. Persist skill row first (T-202 idempotency). DB-write-before-
      //    storage-commit lets us catch UNIQUE conflicts (slug clash on
      //    concurrent allowDuplicate, or (name, content_hash) clash on
      //    concurrent identical imports) and recover *before* moving files.
      if (action === "updated" && targetSkill) {
        // Capture pre-update state for compensating restore on failure.
        preUpdateSnapshot = targetSkill;
        await this.skillRepo.update(targetSkill.id, {
          description: description ?? targetSkill.description,
          version,
          category: options.category ?? targetSkill.category,
          tags,
          contentHash,
          storagePath,
          status: "published",
          retrievalMeta,
          ...importMeta,
          importedAt: Date.now(),
        });
        skillId = targetSkill.id;
      } else {
        let attempt = 0;
        const MAX_RETRIES = 5;
        // The retry loop: on a slug UNIQUE conflict in the allowDuplicate
        // branch we bump the slug suffix and try again (concurrent imports
        // racing on the same slug). On a (name, content_hash) UNIQUE
        // conflict we recover the winner via findByNameAndHash and short-
        // circuit the rest of the import.
        while (true) {
          try {
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
              retrievalMeta,
              ...importMeta,
              importedAt: Date.now(),
            });
            skillId = created.id;
            createdSkillId = created.id;
            break;
          } catch (createErr) {
            if (!isUniqueConstraintError(createErr)) throw createErr;
            // Recover from (name, content_hash) clash: same payload already
            // landed via a parallel importer — return that winner.
            const winner = await this.skillRepo.findByNameAndHash(meta.name, contentHash);
            if (winner) {
              recoveredWinner = winner;
              skillId = winner.id;
              slug = winner.slug;
              storagePath = winner.storagePath;
              break;
            }
            // Otherwise it's a pure slug clash. allowDuplicate callers can
            // recover by bumping; everyone else surfaces the original error.
            if (!options.allowDuplicate || attempt >= MAX_RETRIES) {
              throw createErr;
            }
            attempt++;
            slug = await this.uniqueSlug(baseSlug);
            storagePath = `${slug}/`;
          }
        }
      }

      // 4. Commit storage: stage → final.
      //    Skipped when we recovered from a (name, content_hash) race —
      //    the winner already owns the final path.
      if (!recoveredWinner) {
        if (action === "created") {
          await this.storage.moveDir(stagingPath, storagePath);
        } else {
          await pMap(skillFiles, STORAGE_CONCURRENCY, (file) =>
            this.storage.put(`${storagePath}${file.path}`, file.buffer),
          );
        }
        storageCommitted = true;

        // 5. Persist file rows atomically (single DB tx).
        await this.skillFileRepo.replaceAll(skillId, skillFiles.map(file => ({
          filePath: file.path,
          fileType: isTextFile(file.path) ? "text" : "binary",
          fileSize: file.buffer.length,
          mimeType: getMimeType(file.path),
        })));

        // 6. P1-12 stage 2 — replace persisted eval cases with the validated
        //    frontmatter view. `replaceAll` semantics: a re-imported skill
        //    that dropped a case gets that row pruned. Stage 1's caps and
        //    name-uniqueness checks already ran via validateSkillMetaFields
        //    above; the repo writes the rows verbatim. If `evalCases` is
        //    undefined the repo no-ops cleanly (delete-then-empty-loop).
        if (this.evalRepo) {
          this.evalRepo.replaceAllForSkill(skillId, meta.evalCases ?? []);
        }
      }
    } catch (error) {
      // Compensating cleanup. Order matters: roll DB before storage so the
      // skill row never points at a missing directory.
      if (createdSkillId) {
        try {
          await this.skillRepo.delete(slug);
        } catch (cleanupErr) {
          this.logger.warn({ err: cleanupErr, slug }, "Failed to roll back skill row after import error");
        }
      } else if (action === "updated" && preUpdateSnapshot) {
        // Update path: restore the row to its pre-update state so callers
        // don't see a row whose contentHash/version no longer match the
        // bytes on disk. The historical snapshot taken at step 2 still lives
        // under .versions/, untouched.
        try {
          await this.skillRepo.update(preUpdateSnapshot.id, {
            description: preUpdateSnapshot.description,
            version: preUpdateSnapshot.version,
            category: preUpdateSnapshot.category,
            tags: preUpdateSnapshot.tags,
            contentHash: preUpdateSnapshot.contentHash,
            storagePath: preUpdateSnapshot.storagePath,
            status: preUpdateSnapshot.status,
            retrievalMeta: preUpdateSnapshot.retrievalMeta,
          });
        } catch (restoreErr) {
          this.logger.error(
            { err: restoreErr, skillId: preUpdateSnapshot.id, slug },
            "Failed to restore pre-update skill row after import error — manual repair may be required",
          );
        }
      }
      if (storageCommitted && action === "created") {
        // We just created and moved into finalPath — roll it back.
        await this.storage.deleteDir(storagePath).catch((cleanupErr) => {
          this.logger.warn({ err: cleanupErr, storagePath }, "Failed to roll back final storage after import error");
        });
      }
      throw error;
    } finally {
      // Always remove staging — moveDir consumed it on the create happy path
      // (deleteDir is then a no-op), but every other branch leaves it behind.
      await this.storage.deleteDir(stagingPath).catch((cleanupErr) => {
        this.logger.warn({ err: cleanupErr, stagingPath }, "Failed to clean up import staging directory");
      });
    }

    if (recoveredWinner) {
      // Surface both sides of the swap so callers debugging "I imported X but
      // got back skill Y" can see the requested vs. recovered identity at a
      // glance. requestedSlug = baseSlug (captured before the retry loop
      // reassigned slug), requestedVersion = the version we computed from
      // the incoming manifest.
      this.logger.info(
        {
          importId,
          name: meta.name,
          requestedSlug: baseSlug,
          requestedVersion: version,
          winnerSlug: recoveredWinner.slug,
          winnerVersion: recoveredWinner.version,
          winnerId: recoveredWinner.id,
        },
        "Idempotent import: returning concurrent winner",
      );
      return {
        id: recoveredWinner.id,
        slug: recoveredWinner.slug,
        name: recoveredWinner.name,
        version: recoveredWinner.version,
        fileCount: skillFiles.length,
        category: recoveredWinner.category ?? undefined,
        tags: (recoveredWinner.tags as string[]) ?? [],
        action: "updated",
      };
    }

    const finalSkill = await this.skillRepo.findBySlug(slug);
    this.eventBus?.publish({
      type: "skill:imported",
      slug,
      visibility: finalSkill?.visibility,
      tags: finalSkill?.tags ?? tags,
      name: meta.name,
      version,
      action,
    });

    // P1-13 — record `storage.write` with `quantity = bytes written`. Counts
    // raw payload size of the imported files (post-validation, pre-staging),
    // matching review §9.1 example. The importer is currently tenant-agnostic
    // (rows default to `default`); when multi-tenant import lands the value
    // should flow in via ImportOptions.
    if (this.usageMeter) {
      const bytes = skillFiles.reduce((acc, f) => acc + f.buffer.byteLength, 0);
      void this.usageMeter.record({
        eventType: "storage.write",
        resourceId: slug,
        quantity: bytes,
        metadata: { action, fileCount: skillFiles.length },
      });
    }

    this.logger.info({ slug, name: meta.name, version, action, fileCount: skillFiles.length }, "Skill imported");

    // Record the new version as current
    if (this.versionRepo) {
      this.versionRepo.create({
        skillId,
        version,
        contentHash,
        storagePath,
        fileCount: skillFiles.length,
        isCurrent: true,
      });
    }

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
      throw new InvalidManifestError("SKILL.md not found in skill files");
    }

    const { frontmatter } = extractFrontmatter(skillFile.buffer.toString("utf-8"));
    const name = frontmatter["name"];
    if (!name || typeof name !== "string") {
      throw new InvalidManifestError("name is required in SKILL.md frontmatter");
    }

    return {
      name: name as string,
      version: (frontmatter["version"] as string) ?? undefined,
      description: (frontmatter["description"] as string) ?? undefined,
      entry: (frontmatter["entry"] as string) ?? "SKILL.md",
      files: frontmatter["files"] as string[] | undefined,
      tags: frontmatter["tags"] as string[] | undefined,
      category: (frontmatter["category"] as string) ?? undefined,
      manifestSchema: (frontmatter["manifest_schema"] as string) ?? undefined,
      triggers: frontmatter["triggers"] as string[] | undefined,
      whenToUse: (frontmatter["when_to_use"] as string) ?? undefined,
      embeddingText: (frontmatter["embedding_text"] as string) ?? undefined,
      evalCases: parseEvalCases(frontmatter["eval_cases"] ?? frontmatter["evalCases"]),
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
    const finalSkill = await this.skillRepo.findBySlug(slug);
    this.eventBus?.publish({
      type: "skill:updated",
      slug,
      visibility: finalSkill?.visibility,
      tags: finalSkill?.tags ?? tags,
    });
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
      // listRecursive returns paths WITH the prefix (e.g., "demo-skill/SKILL.md")
      const files = await this.storage.listRecursive(skill.storagePath);
      const targets = files.filter(p => !p.includes("/.versions/") && !p.startsWith(".versions/"));
      const copied = await pMap(targets, STORAGE_CONCURRENCY, async (filePath) => {
        // filePath already includes the prefix, so use it directly
        const content = await this.storage.get(filePath);
        if (!content) return false;
        // Strip the prefix for the version path
        const relativePath = filePath.startsWith(skill.storagePath)
          ? filePath.slice(skill.storagePath.length)
          : filePath;
        await this.storage.put(`${versionPath}${relativePath}`, content);
        return true;
      });
      const fileCount = copied.filter(Boolean).length;

      // Find existing version record and update it to point to the snapshot
      const existing = this.versionRepo.findByVersion(skill.id, skill.version);
      if (existing) {
        // Update existing record to point to snapshot path
        this.versionRepo.update(existing.id, {
          storagePath: versionPath,
          fileCount,
          isCurrent: false,
        });
      } else {
        // Create new record if none exists
        this.versionRepo.create({
          skillId: skill.id,
          version: skill.version,
          contentHash: skill.contentHash!,
          storagePath: versionPath,
          entryFile: skill.entryFile,
          fileCount,
          isCurrent: false,
        });
      }

      this.logger.debug({ skillId: skill.id, version: skill.version, fileCount }, "Version snapshot created");
    } catch (error) {
      this.logger.warn({ error, skillId: skill.id, version: skill.version }, "Failed to snapshot version");
    }
  }
}
