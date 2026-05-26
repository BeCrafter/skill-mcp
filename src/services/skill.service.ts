import type { Logger } from "pino";
import type { ISkillProvider } from "../provider/interface.js";
import type { ICacheProvider } from "../cache/provider.interface.js";
import type { AccessLogService } from "./access-log.service.js";
import type { SkillFeedbackRepository } from "../db/repositories/skill-feedback.repository.js";
import type { SkillVersionRepository } from "../db/repositories/skill-version.repository.js";
import type { SkillRepository } from "../db/repositories/skill.repository.js";
import type { SkillFileRepository } from "../db/repositories/skill-file.repository.js";
import type { IStorageProvider } from "../storage/provider.interface.js";
import { getMimeType, isTextFile } from "../utils/security.js";
import { CacheEpochManager } from "../cache/cache-epochs.js";
import { TagPermissionFilter } from "../permission/tag-filter.js";
import { scanForInjection } from "../utils/security.js";
import { metrics } from "../telemetry/metrics.js";
import {
  BadRequestError,
  ConfigurationError,
  PermissionDeniedError,
  SkillNotFoundError,
  VersionNotFoundError,
} from "../utils/errors.js";
import { bumpVersion } from "../db/repositories/skill.repository.js";
import { pMap } from "../utils/concurrency.js";
import { randomUUID } from "node:crypto";

const STORAGE_CONCURRENCY = 8;
const ROLLBACK_STAGING_ROOT = "__staging__";
import type { SkillMeta, SkillMetaPublic, SkillFileContent, FileInfo, RequestContext, VersionBump } from "../types/index.js";
import { toSkillMetaPublic } from "../types/index.js";

const SKILL_LIST_TTL_SECONDS = 600;

function anonymousContext(): RequestContext {
  return { userId: "anonymous", sessionId: "anonymous", tags: new Set(), isAuthenticated: false };
}

export interface ListSkillsOptions {
  category?: string;
  tags?: string[];
  attributes?: Record<string, string>;
}

export class SkillService {
  private accessLog: AccessLogService | null;
  private feedbackRepo: SkillFeedbackRepository | null;
  private versionRepo: SkillVersionRepository | null;
  private skillRepo: SkillRepository | null;
  private skillFileRepo: SkillFileRepository | null;
  private storage: IStorageProvider | null;
  private epochs: CacheEpochManager;

  constructor(
    private skillProvider: ISkillProvider,
    private cache: ICacheProvider,
    private logger: Logger,
    accessLog?: AccessLogService,
    feedbackRepo?: SkillFeedbackRepository,
    versionRepo?: SkillVersionRepository,
    skillRepo?: SkillRepository,
    storage?: IStorageProvider,
    epochs?: CacheEpochManager,
    skillFileRepo?: SkillFileRepository,
  ) {
    this.accessLog = accessLog ?? null;
    this.feedbackRepo = feedbackRepo ?? null;
    this.versionRepo = versionRepo ?? null;
    this.skillRepo = skillRepo ?? null;
    this.skillFileRepo = skillFileRepo ?? null;
    this.storage = storage ?? null;
    // Falls back to a private (no-op-as-far-as-the-app-is-concerned) manager
    // when not wired in (CLI scripts, unit tests). The cache key still
    // includes the version suffix; old keys naturally expire by TTL.
    this.epochs = epochs ?? new CacheEpochManager();
  }

  /**
   * Resolve the set of skills the caller is allowed to see, with caching.
   * Cache key is per-user (anonymous shares one bucket); the result is the
   * full visibility-filtered list — opts.category/tags/attributes are
   * applied in-memory by callers afterward so callers share the same key.
   */
  private async getAccessibleSkillsForUser(context: RequestContext): Promise<SkillMetaPublic[]> {
    const cacheKey = `skill:list:${context.userId}:${this.epochs.versionSuffix(context.userId)}`;
    const cached = await this.cache.get<SkillMetaPublic[]>(cacheKey);
    if (cached) return cached;

    const all = await this.skillProvider.listSkills();
    const filter = new TagPermissionFilter(context);
    const allowed = await filter.filter(all);
    const publicAllowed = allowed.map(toSkillMetaPublic);
    await this.cache.set(cacheKey, publicAllowed, SKILL_LIST_TTL_SECONDS);
    return publicAllowed;
  }

  private applyListFilters<T extends Pick<SkillMeta, "category" | "tags" | "attributes">>(
    skills: T[],
    opts?: ListSkillsOptions,
  ): T[] {
    let result = skills;
    if (opts?.category) {
      result = result.filter(s => s.category === opts.category);
    }
    if (opts?.tags && opts.tags.length > 0) {
      const tagSet = opts.tags;
      result = result.filter(s => {
        const skillTags = Array.isArray(s.tags) ? s.tags : [];
        return tagSet.some(t => skillTags.includes(t));
      });
    }
    if (opts?.attributes && Object.keys(opts.attributes).length > 0) {
      const entries = Object.entries(opts.attributes);
      result = result.filter(s => {
        const attrs = (s.attributes ?? {}) as Record<string, unknown>;
        return entries.every(([k, v]) => String(attrs[k] ?? "") === v);
      });
    }
    return result;
  }

  /**
   * Public API: returns the metadata array (HTTP gateway / admin clients).
   * Includes draft/archived/etc — callers decide what statuses they want.
   */
  async listAccessibleSkills(context: RequestContext | undefined, opts?: ListSkillsOptions): Promise<SkillMetaPublic[]> {
    const ctx = context ?? anonymousContext();
    const allowed = await this.getAccessibleSkillsForUser(ctx);
    return this.applyListFilters(allowed, opts);
  }

  /** Build the skills index for MCP instructions (flat list, no grouping) */
  async listSkillsIndex(context?: RequestContext, tags?: string[]): Promise<string> {
    const start = Date.now();
    const ctx = context ?? anonymousContext();

    let skills = await this.getAccessibleSkillsForUser(ctx);
    skills = this.applyListFilters(skills, { tags });

    const published = skills.filter(s => s.status === "published");

    // Fetch effectiveness rates in bulk (one DB query)
    const rates = this.feedbackRepo
      ? await this.feedbackRepo.getEffectivenessRates()
      : new Map<string, { rate: number; count: number }>();

    const sorted = published.sort((a, b) => {
      const rateA = rates.get(a.slug)?.rate ?? 0.5;
      const rateB = rates.get(b.slug)?.rate ?? 0.5;
      // Primary: effectiveness rate descending
      if (rateA !== rateB) return rateB - rateA;
      // Secondary: slug ascending (stable tiebreaker)
      return a.slug.localeCompare(b.slug);
    });

    const lines = sorted.map(s => {
      const desc = (s.description ?? "").length > 80
        ? s.description.slice(0, 77) + "..."
        : s.description;
      return `    - ${s.slug} [id:${s.id}]: ${desc}`;
    });

    if (this.accessLog && sorted.length > 0) {
      this.accessLog.log({
        skillId: sorted[0].id,
        skillSlug: "__index__",
        action: "list",
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        latencyMs: Date.now() - start,
      }).catch(() => {});
    }

    return lines.join("\n");
  }

  private async resolveSkill(identifier: string): Promise<SkillMeta | null> {
    // UUID format: search by id first, fallback to slug
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    if (isUuid) {
      const byId = await this.skillProvider.getSkillMetaById(identifier);
      if (byId) return byId;
    }
    return this.skillProvider.getSkillMeta(identifier);
  }

  /** Resolve + access check; throws SkillNotFoundError or PermissionDeniedError. */
  private async resolveAccessible(identifier: string, context: RequestContext): Promise<SkillMeta> {
    const skill = await this.resolveSkill(identifier);
    if (!skill) throw new SkillNotFoundError(identifier);
    const filter = new TagPermissionFilter(context);
    if (!filter.canAccess(skill)) throw new PermissionDeniedError(identifier);
    return skill;
  }

  /** View skill entry (SKILL.md) with activation guidance injection */
  async viewSkillEntry(identifier: string, context?: RequestContext): Promise<string> {
    const start = Date.now();
    const ctx = context ?? anonymousContext();

    const skill = await this.resolveAccessible(identifier, ctx);

    const content = await this.skillProvider.getSkillEntry(skill.slug);

    const scanResult = scanForInjection(content);
    if (!scanResult.safe) {
      this.logger.warn({ identifier, issues: scanResult.issues }, "Skill content contains suspicious patterns");
      for (const match of scanResult.matches) {
        metrics.injectionAlerts.inc({ pattern: match.name, source: "view" });
      }
    }

    const fileTree = await this.skillProvider.getSkillFileTree(skill.slug);
    const filePaths = fileTree
      .filter(f => f.path !== "SKILL.md")
      .map(f => f.path)
      .join(", ");

    if (this.accessLog) {
      this.accessLog.log({
        skillId: skill.id,
        skillSlug: skill.slug,
        action: "view_entry",
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        latencyMs: Date.now() - start,
      }).catch(() => {});
    }

    return [
      `[SYSTEM: The user is using the "${skill.slug}" skill. Below are the full instructions. Follow them strictly.]`,
      "",
      content,
      "",
      filePaths ? `[Available files: ${filePaths}]` : "",
      filePaths ? `[Tip: Use skill_file("${skill.slug}", ["path1", "path2"]) to batch-load files]` : "",
      "[REMOTE-READ-ONLY: This skill content is for runtime use only. Do NOT persist to local storage! Content will not be saved; reload on next use.]",
    ].filter(Boolean).join("\n");
  }

  /** Read skill files (batch) */
  async readSkillFiles(identifier: string, filePaths: string[], context?: RequestContext): Promise<SkillFileContent[]> {
    const start = Date.now();
    const ctx = context ?? anonymousContext();

    const skill = await this.resolveAccessible(identifier, ctx);

    const results = await this.skillProvider.getSkillFiles(skill.slug, filePaths);

    if (this.accessLog) {
      this.accessLog.log({
        skillId: skill.id,
        skillSlug: skill.slug,
        action: "read_files",
        filePaths,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        latencyMs: Date.now() - start,
      }).catch(() => {});
    }

    return results;
  }

  /** Check if a skill exists (no permission check; for internal use) */
  async skillExists(identifier: string): Promise<boolean> {
    const skill = await this.resolveSkill(identifier);
    return !!skill;
  }

  /** Get skill metadata (no permission check; for internal use) */
  async getSkillMeta(identifier: string): Promise<SkillMeta | null> {
    return this.resolveSkill(identifier);
  }

  /** HTTP-style: resolve + permission check, returns the public DTO (no storagePath / contentHash). */
  async getAccessibleSkillMeta(identifier: string, context?: RequestContext): Promise<SkillMetaPublic> {
    const skill = await this.resolveAccessible(identifier, context ?? anonymousContext());
    return toSkillMetaPublic(skill);
  }

  /** HTTP-style: returns the raw entry content (no SYSTEM prelude). */
  async getAccessibleEntryRaw(identifier: string, context?: RequestContext): Promise<string> {
    const skill = await this.resolveAccessible(identifier, context ?? anonymousContext());
    return this.skillProvider.getSkillEntry(skill.slug);
  }

  /** HTTP-style: returns the file tree for an accessible skill. */
  async getAccessibleFileTree(identifier: string, context?: RequestContext): Promise<FileInfo[]> {
    const skill = await this.resolveAccessible(identifier, context ?? anonymousContext());
    return this.skillProvider.getSkillFileTree(skill.slug);
  }

  /** Submit skill feedback */
  async submitFeedback(
    input: { skill_slug: string; outcome: string; context: string; agent_comment: string },
    requestContext?: RequestContext,
  ): Promise<void> {
    // T-715 — feedback writes share the same authorization model as
    // viewSkillEntry / readSkillFiles. Without `resolveAccessible`, a caller
    // could enumerate or spam feedback on skills they cannot otherwise see;
    // throwing here keeps the gating consistent across all per-skill MCP
    // tools and surfaces denial via the same PermissionDeniedError path.
    const ctx = requestContext ?? anonymousContext();
    const skill = await this.resolveAccessible(input.skill_slug, ctx);

    // T-727 — service-layer caps so any future non-MCP transport (HTTP,
    // gRPC, …) hitting `submitFeedback` cannot land 10 MiB strings in
    // user-writable rows. MCP `inputSchema` already enforces the same
    // numbers; this is the belt-and-braces backstop.
    if (input.context.length > 2000) {
      throw new BadRequestError("context exceeds max length of 2000");
    }
    if (input.agent_comment.length > 8000) {
      throw new BadRequestError("agent_comment exceeds max length of 8000");
    }

    if (!this.feedbackRepo) throw new ConfigurationError("Feedback repository not configured");

    await this.feedbackRepo.create({
      skillId: skill.id,
      skillSlug: input.skill_slug,
      userId: requestContext?.userId ?? null,
      sessionId: requestContext?.sessionId ?? null,
      outcome: input.outcome as "success" | "partial" | "failure" | "irrelevant",
      context: input.context,
      agentComment: input.agent_comment,
    });
  }

  /** Get effectiveness rate for a skill */
  async getSkillEffectivenessRate(slug: string, days = 30): Promise<number> {
    if (!this.feedbackRepo) return 0.5;

    const feedbacks = await this.feedbackRepo.findBySlug(slug, days);
    if (feedbacks.length === 0) return 0.5;

    const successCount = feedbacks.filter(f =>
      f.outcome === "success" || f.outcome === "partial"
    ).length;

    return successCount / feedbacks.length;
  }

  /** Get effectiveness rates for all skills */
  async getEffectivenessRates(days?: number): Promise<Map<string, { rate: number; count: number }>> {
    if (!this.feedbackRepo) return new Map();
    return this.feedbackRepo.getEffectivenessRates(days);
  }

  /** Get version history for a skill */
  async getVersions(slug: string, limit?: number) {
    if (!this.versionRepo || !this.skillRepo) throw new ConfigurationError("Version repository not configured");
    const skill = await this.skillProvider.getSkillMeta(slug);
    if (!skill) throw new SkillNotFoundError(slug);
    return this.versionRepo.findBySkillId(skill.id, limit);
  }

  /** Rollback skill to a specific version */
  async rollbackToVersion(slug: string, targetVersion: string, bump: VersionBump = "patch"): Promise<void> {
    if (!this.versionRepo || !this.skillRepo || !this.storage) {
      throw new ConfigurationError("Version repository, skill repository, or storage not configured");
    }
    const storage = this.storage;

    const skill = await this.skillProvider.getSkillMeta(slug);
    if (!skill) throw new SkillNotFoundError(slug);

    const version = this.versionRepo.findByVersion(skill.id, targetVersion);
    if (!version) throw new VersionNotFoundError(slug, targetVersion);

    // 1. Snapshot current version (non-destructive: writes only to .versions/<v>/).
    const currentVersionPath = `${skill.storagePath}.versions/${skill.version}/`;
    const currentFiles = await storage.listRecursive(skill.storagePath);
    const snapshotTargets = currentFiles.filter(p => !p.startsWith(".versions/"));
    const copied = await pMap(snapshotTargets, STORAGE_CONCURRENCY, async (filePath) => {
      const content = await storage.get(`${skill.storagePath}${filePath}`);
      if (!content) return false;
      await storage.put(`${currentVersionPath}${filePath}`, content);
      return true;
    });
    const currentFileCount = copied.filter(Boolean).length;
    this.versionRepo.create({
      skillId: skill.id,
      version: skill.version,
      contentHash: skill.contentHash!,
      storagePath: currentVersionPath,
      entryFile: skill.entryFile,
      fileCount: currentFileCount,
      changeSummary: `Pre-rollback snapshot before restoring to ${targetVersion}`,
    });

    const runId = randomUUID();
    const stagingPath = `${ROLLBACK_STAGING_ROOT}/${runId}/`;
    const newVersion = bumpVersion(skill.version, bump);
    let dbUpdated = false;
    let storageCommitted = false;

    try {
      // 2. Stage target version into per-run scratch dir (non-destructive).
      //    Track byte sizes here so step 4b can refresh skill_files without
      //    a second round-trip through storage.
      const versionFiles = await storage.listRecursive(version.storagePath);
      const stagedSizes = new Map<string, number>();
      await pMap(versionFiles, STORAGE_CONCURRENCY, async (filePath) => {
        const content = await storage.get(`${version.storagePath}${filePath}`);
        if (!content) return;
        stagedSizes.set(filePath, content.byteLength);
        await storage.put(`${stagingPath}${filePath}`, content);
      });

      // 3. Commit storage from staging to live path (per-file overwrite —
      //    moveDir/rename can't replace a non-empty directory).
      // T-723 — before writing the target version, delete files that exist
      // in the live tree but not in the target version. Without this, files
      // added in versions newer than the target survive rollback (e.g.
      // v3 → v1 leaves any v2/v3 additions on disk), and `getSkillFile` /
      // `listRecursive` returns a union instead of v1's actual file set.
      // `snapshotTargets` is the live tree minus `.versions/` (already
      // filtered in step 1), so we reuse it instead of re-listing.
      const targetSet = new Set(versionFiles);
      const stalePaths = snapshotTargets.filter(p => !targetSet.has(p));
      await pMap(stalePaths, STORAGE_CONCURRENCY, async (filePath) => {
        await storage.delete(`${skill.storagePath}${filePath}`);
      });
      await pMap(versionFiles, STORAGE_CONCURRENCY, async (filePath) => {
        const content = await storage.get(`${stagingPath}${filePath}`);
        if (!content) return;
        await storage.put(`${skill.storagePath}${filePath}`, content);
      });
      storageCommitted = true;

      // 4. DB version pointer update (single atomic row update).
      await this.skillRepo.update(skill.id, {
        version: newVersion,
        contentHash: version.contentHash,
      });
      dbUpdated = true;

      // 4b. T-724 — refresh `skill_files` index to match the just-committed
      //     storage. Without this, `LocalSkillProvider.getSkillFileTree`
      //     returns the pre-rollback file list (since it reads the index
      //     before falling back to walking storage), so `skill_file` MCP
      //     calls report paths inconsistent with the version pointer.
      //     Mirrors the importer's post-commit `replaceAll` (importer.ts).
      if (this.skillFileRepo) {
        const fileRows = versionFiles.map((filePath) => ({
          filePath,
          fileType: isTextFile(filePath) ? "text" : "binary",
          fileSize: stagedSizes.get(filePath) ?? 0,
          mimeType: getMimeType(filePath),
        }));
        await this.skillFileRepo.replaceAll(skill.id, fileRows);
      }

      // 5. Synchronous cache invalidation — close the read-after-rollback window.
      // T-711 — DB and storage are already committed at this point; a transient
      // cache provider failure is recoverable (TTL + cache-aside semantics) but
      // throwing here would trigger the outer compensating restore that undoes
      // a successful rollback. Log and proceed; cache staleness is acceptable,
      // data inconsistency between DB / storage is not.
      try {
        await this.cache.clearByPrefix(`skill:entry:${slug}`);
        await this.cache.clearByPrefix(`skill:file:${slug}`);
      } catch (cacheErr) {
        this.logger.warn(
          { err: cacheErr, slug },
          "Cache invalidation failed after rollback commit; relying on TTL",
        );
      }
    } catch (err) {
      // Compensating restore from the just-made snapshot. Order: storage
      // first (so live tree matches DB), then DB if it had been advanced.
      if (storageCommitted) {
        try {
          const restoreFiles = await storage.listRecursive(currentVersionPath);
          await pMap(restoreFiles, STORAGE_CONCURRENCY, async (filePath) => {
            const content = await storage.get(`${currentVersionPath}${filePath}`);
            if (!content) return;
            await storage.put(`${skill.storagePath}${filePath}`, content);
          });
        } catch (cleanupErr) {
          this.logger.error({ err: cleanupErr, slug }, "Failed to restore storage from pre-rollback snapshot");
        }
      }
      if (dbUpdated) {
        try {
          await this.skillRepo.update(skill.id, {
            version: skill.version,
            contentHash: skill.contentHash,
          });
        } catch (cleanupErr) {
          this.logger.error({ err: cleanupErr, slug }, "Failed to roll back DB version after rollback error");
        }
      }
      throw err;
    } finally {
      await storage.deleteDir(stagingPath).catch((cleanupErr) => {
        this.logger.warn({ err: cleanupErr, stagingPath }, "Failed to clean up rollback staging directory");
      });
    }

    this.logger.info({ slug, from: skill.version, to: newVersion, restored: targetVersion }, "Skill rolled back");
  }
}
