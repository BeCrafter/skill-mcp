import type { Logger } from "pino";
import type { ISkillProvider } from "../provider/interface.js";
import type { ICacheProvider } from "../cache/provider.interface.js";
import type { AccessLogService } from "./access-log.service.js";
import type { SkillFeedbackRepository } from "../db/repositories/skill-feedback.repository.js";
import type { SkillVersionRepository } from "../db/repositories/skill-version.repository.js";
import type { SkillRepository } from "../db/repositories/skill.repository.js";
import type { SkillFileRepository } from "../db/repositories/skill-file.repository.js";
import type { AccessLogRepository } from "../db/repositories/access-log.repository.js";
import type { DomainEventBus } from "../events/event-bus.js";
import type { SkillImporter } from "../import/importer.js";
import type { IStorageProvider } from "../storage/provider.interface.js";
import type { UsageMeterService } from "./usage-meter.service.js";
import type { SkillSearchService } from "./skill-search.service.js";
import type { SkillEvalRepository } from "../db/repositories/skill-eval.repository.js";
import { getMimeType, isTextFile } from "../utils/security.js";
import { CacheEpochManager } from "../cache/cache-epochs.js";
import { TagPermissionFilter } from "../permission/tag-filter.js";
import { assertTransition, IllegalTransitionError, nextStates } from "./skill-lifecycle.js";
import { scanForInjection } from "../utils/security.js";
import { metrics } from "../telemetry/metrics.js";
import { withSpan } from "../telemetry/spans.js";
import {
  BadRequestError,
  ConfigurationError,
  EvalRegressionError,
  PermissionDeniedError,
  SkillNotFoundError,
  VersionNotFoundError,
} from "../utils/errors.js";
import { bumpVersion } from "../db/repositories/skill.repository.js";
import { pMap } from "../utils/concurrency.js";
import { randomUUID } from "node:crypto";

const STORAGE_CONCURRENCY = 8;
const ROLLBACK_STAGING_ROOT = "__staging__";
// P0-A — admin update PUT allowlist. `storagePath` / `contentHash` stay
// system-managed (importer + rollback compute them); admin PUT must not
// be able to redirect a skill's storage location or rewrite its hash.
const ADMIN_PUT_ALLOWED = [
  "description", "displayName", "version", "category",
  "attributes", "status", "visibility", "entryFile", "tags",
] as const;
import type { SkillMeta, SkillMetaPublic, SkillFileContent, FileInfo, RequestContext, VersionBump, SkillStatus, ImportOptions, ImportResult, AccessLogEntry, SkillRetrievalMeta } from "../types/index.js";
import { DEFAULT_TENANT_ID, toSkillMetaPublic } from "../types/index.js";

/**
 * Optional dependencies required by the admin convergence methods (P0-A).
 * SkillService keeps backward compatibility with the existing positional
 * constructor signature; admin callers (HTTP admin handler, CLI) pass these
 * via the trailing options bag so service-layer tests that only need MCP
 * read paths can keep their slim mocks.
 */
export interface SkillServiceAdminDeps {
  eventBus?: DomainEventBus;
  importer?: SkillImporter;
  accessLogRepo?: AccessLogRepository;
  // P1-13 — usage metering hook for skill.view. Optional so MCP-read paths
  // continue to work without it; when wired, every accessible viewSkillEntry
  // emits a fire-and-forget `skill.view` event tagged with the resolved slug.
  usageMeter?: UsageMeterService;
  // P1-11 stage 2b — BM25 retrieval. Optional so service-layer tests that
  // only exercise the read path keep passing without an in-memory index;
  // when absent, listAccessibleSkills({query}) and searchAccessibleSkills
  // fall back to a substring scan on name/description.
  searchService?: SkillSearchService;
  // P1-12 stage 3 — eval regression gate. When wired, transitions to
  // `published` consult `findLatestRunStatusByCase(skillId, version)` and
  // refuse the transition unless every case has a `pass` row for the
  // current version. Absent → gate is a no-op (legacy callers preserved).
  evalRepo?: SkillEvalRepository;
}

export interface TransitionLifecycleOptions {
  /**
   * P1-12 stage 3 — emergency override for the publish-time eval regression
   * gate. Skips the `findLatestRunStatusByCase` check; the transition still
   * runs through the state machine. Defaults to false. The admin REST handler
   * surfaces this via `?force=true`; callers must justify use because a
   * forced publish leaves a regression-prone version live until the next
   * `eval run` writes a fresh result.
   */
  skipEvalGate?: boolean;
}

const SKILL_LIST_TTL_SECONDS = 600;

function anonymousContext(): RequestContext {
  return { tenantId: DEFAULT_TENANT_ID, userId: "anonymous", sessionId: "anonymous", tags: new Set(), isAuthenticated: false };
}

export interface ListSkillsOptions {
  category?: string;
  tags?: string[];
  attributes?: Record<string, string>;
  /**
   * P1-11 stage 2b — when set, filter the visible result set to skills
   * matching the query and order them by BM25 relevance descending.
   * Falls back to a case-insensitive substring scan over name + description
   * when no SkillSearchService is wired (service-layer unit tests / cloud
   * mode without the index hydrated yet).
   */
  query?: string;
  /** Hard cap when {@link query} is set. Defaults to 20. */
  searchLimit?: number;
  /** P1-11 stage 3 — selects ranking signal when query is set. Defaults to "bm25". */
  searchMode?: "bm25" | "vector" | "hybrid";
  /** P1-11 stage 3 — α weight on BM25 when searchMode is "hybrid". */
  searchHybridAlpha?: number;
}

/** P1-11 stage 2b — public hit shape for `skill_search` consumers. */
export interface SkillSearchHit {
  skill: SkillMetaPublic;
  score: number;
}

export class SkillService {
  private accessLog: AccessLogService | null;
  private feedbackRepo: SkillFeedbackRepository | null;
  private versionRepo: SkillVersionRepository | null;
  private skillRepo: SkillRepository | null;
  private skillFileRepo: SkillFileRepository | null;
  private storage: IStorageProvider | null;
  private epochs: CacheEpochManager;
  // P0-A — admin convergence deps. Optional so existing callers (rollback CLI,
  // unit tests) need not pass them; admin* methods raise ConfigurationError
  // when accessed without the matching dep wired in.
  private eventBus: DomainEventBus | null;
  private importer: SkillImporter | null;
  private accessLogRepo: AccessLogRepository | null;
  private usageMeter: UsageMeterService | null;
  private searchService: SkillSearchService | null;
  private evalRepo: SkillEvalRepository | null;

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
    adminDeps?: SkillServiceAdminDeps,
  ) {
    this.accessLog = accessLog ?? null;
    this.feedbackRepo = feedbackRepo ?? null;
    this.versionRepo = versionRepo ?? null;
    this.skillRepo = skillRepo ?? null;
    this.skillFileRepo = skillFileRepo ?? null;
    this.storage = storage ?? null;
    this.eventBus = adminDeps?.eventBus ?? null;
    this.importer = adminDeps?.importer ?? null;
    this.accessLogRepo = adminDeps?.accessLogRepo ?? null;
    this.usageMeter = adminDeps?.usageMeter ?? null;
    this.searchService = adminDeps?.searchService ?? null;
    this.evalRepo = adminDeps?.evalRepo ?? null;
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

  /**
   * P1-11 stages 2b + 3 — order a permission-filtered skill set by ranking
   * score. When the SkillSearchService is wired and ready, defer to it;
   * otherwise fall back to a case-insensitive substring scan so callers
   * (e.g. cloud mode without the index, unit tests) still get reasonable
   * behavior. The fallback isn't BM25-quality but lets `?query=` be a
   * stable contract.
   *
   * `mode`: "bm25" (default) | "vector" | "hybrid". For vector / hybrid
   * we await an async embedding round-trip; the BM25-only fast path stays
   * synchronous internally for cheapness. `hybridAlpha` is forwarded
   * verbatim to the hybrid scorer.
   */
  private async rankByQuery(
    skills: SkillMetaPublic[],
    query: string,
    limit: number,
    mode: "bm25" | "vector" | "hybrid" = "bm25",
    hybridAlpha?: number,
  ): Promise<SkillSearchHit[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return skills.slice(0, limit).map(skill => ({ skill, score: 0 }));

    if (this.searchService && this.searchService.isReady()) {
      const hits = mode === "bm25"
        ? this.searchService.search(trimmed, { limit: Math.max(limit, 20) })
        : await this.searchService.searchAsync(trimmed, { limit: Math.max(limit, 20), mode, hybridAlpha });
      const byId = new Map(skills.map(s => [s.id, s] as const));
      const ranked: SkillSearchHit[] = [];
      for (const hit of hits) {
        const skill = byId.get(hit.skillId);
        if (skill) ranked.push({ skill, score: hit.score });
        if (ranked.length >= limit) break;
      }
      return ranked;
    }

    const needle = trimmed.toLowerCase();
    const scanned = skills
      .map((skill) => {
        const haystack = `${skill.name} ${skill.description ?? ""}`.toLowerCase();
        const idx = haystack.indexOf(needle);
        return idx === -1 ? null : { skill, score: 1 / (idx + 1) };
      })
      .filter((hit): hit is SkillSearchHit => hit !== null)
      .sort((a, b) => b.score - a.score);
    return scanned.slice(0, limit);
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
    return withSpan("skill.service.listAccessibleSkills", { ctx }, async () => {
      const allowed = await this.getAccessibleSkillsForUser(ctx);
      const filtered = this.applyListFilters(allowed, opts);
      if (opts?.query && opts.query.trim().length > 0) {
        const limit = opts.searchLimit ?? 20;
        const ranked = await this.rankByQuery(filtered, opts.query, limit, opts.searchMode, opts.searchHybridAlpha);
        return ranked.map((h) => h.skill);
      }
      return filtered;
    });
  }

  /**
   * P1-11 stage 2b — public BM25 search. Returns ranked hits with scores
   * (the MCP `skill_search` tool surfaces the score so the caller can
   * filter on a confidence threshold). Permission filter is applied first
   * so a low-tag user never sees a high-score private skill they cannot
   * load via `skill_view`.
   */
  async searchAccessibleSkills(
    context: RequestContext | undefined,
    query: string,
    opts: {
      limit?: number;
      tags?: string[];
      category?: string;
      /** P1-11 stage 3 — selects ranking signal. */
      mode?: "bm25" | "vector" | "hybrid";
      /** P1-11 stage 3 — α weight on BM25 in hybrid mode (0..1). */
      hybridAlpha?: number;
    } = {},
  ): Promise<SkillSearchHit[]> {
    const ctx = context ?? anonymousContext();
    return withSpan("skill.service.searchAccessibleSkills", { ctx }, async () => {
      const allowed = await this.getAccessibleSkillsForUser(ctx);
      const filtered = this.applyListFilters(allowed, { tags: opts.tags, category: opts.category });
      const limit = opts.limit ?? 20;
      return this.rankByQuery(filtered, query, limit, opts.mode ?? "bm25", opts.hybridAlpha);
    });
  }

  /** Build the skills index for MCP instructions (flat list, no grouping) */
  async listSkillsIndex(context?: RequestContext, tags?: string[], query?: string): Promise<string> {
    const start = Date.now();
    const ctx = context ?? anonymousContext();
    return withSpan("skill.service.listSkillsIndex", { ctx }, () => this._listSkillsIndexImpl(ctx, tags, query, start));
  }

  private async _listSkillsIndexImpl(ctx: RequestContext, tags: string[] | undefined, query: string | undefined, start: number): Promise<string> {
    let skills = await this.getAccessibleSkillsForUser(ctx);
    skills = this.applyListFilters(skills, { tags });

    // P1-11 stage 2b — when the agent passes `query`, narrow + reorder by
    // BM25 relevance. Effectiveness-rate sort below is skipped because the
    // BM25 score already encodes user intent — re-sorting by feedback
    // would frustrate "I asked for X and got something else first".
    if (query && query.trim().length > 0) {
      const ranked = await this.rankByQuery(skills, query, 20);
      const published = ranked.map(h => h.skill).filter(s => s.status === "published");
      const lines = published.map((s) => {
        const desc = (s.description ?? "").length > 80
          ? s.description.slice(0, 77) + "..."
          : s.description;
        return `    - ${s.slug} [id:${s.id}]: ${desc}`;
      });
      if (this.accessLog && published.length > 0) {
        this.accessLog.log({
          skillId: published[0].id,
          skillSlug: "__index__",
          action: "list",
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          latencyMs: Date.now() - start,
        }).catch(() => {});
      }
      return lines.join("\n");
    }

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
    return withSpan(
      "skill.service.viewSkillEntry",
      { ctx, attributes: { "skill.identifier": identifier } },
      () => this._viewSkillEntryImpl(identifier, ctx, start),
    );
  }

  private async _viewSkillEntryImpl(identifier: string, ctx: RequestContext, start: number): Promise<string> {
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

    // P1-13 — usage metering. Fire-and-forget; the underlying service swallows
    // errors so a metering DB hiccup never blocks or fails a view request.
    if (this.usageMeter) {
      void this.usageMeter.record({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        eventType: "skill.view",
        resourceId: skill.slug,
      });
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
    return withSpan(
      "skill.service.readSkillFiles",
      { ctx, attributes: { "skill.identifier": identifier, "skill.file_count": filePaths.length } },
      () => this._readSkillFilesImpl(identifier, filePaths, ctx, start),
    );
  }

  private async _readSkillFilesImpl(identifier: string, filePaths: string[], ctx: RequestContext, start: number): Promise<SkillFileContent[]> {
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

  /**
   * P0-9 — transition a skill's lifecycle state. Resolves the skill by slug
   * (or UUID), validates the requested transition against the state machine
   * (see services/skill-lifecycle.ts), persists, and invalidates the cache.
   * Throws SkillNotFoundError / IllegalTransitionError. Caller is expected to
   * have already passed the admin-tag gate at the HTTP layer; we don't
   * re-check tags here so service-layer tests don't have to fabricate them.
   */
  async transitionLifecycle(
    identifier: string,
    target: SkillStatus,
    options?: TransitionLifecycleOptions,
  ): Promise<SkillMeta> {
    if (!this.skillRepo) throw new ConfigurationError("Skill repository not configured");
    const skill = await this.resolveSkill(identifier);
    if (!skill) throw new SkillNotFoundError(identifier);
    const current = (skill.status ?? "draft") as SkillStatus;
    assertTransition(current, target);

    // P1-12 stage 3 — regression gate. Only blocks transitions *into*
    // `published` (publish + republish); deprecate/archive paths bypass.
    // Gate is a no-op when evalRepo isn't wired (legacy callers / unit tests
    // without an eval store) or when the caller passes skipEvalGate=true.
    if (target === "published" && this.evalRepo && !options?.skipEvalGate) {
      this.assertEvalRegressionGate(skill);
    }

    const updated = await this.skillRepo.update(skill.id, { status: target });
    if (!updated) throw new SkillNotFoundError(identifier);
    // Bump the global epoch so every user's list cache refreshes on the next
    // read. P0-9: deprecate/archive must hide the skill from non-admin lists
    // immediately; without this the prior cached list keeps surfacing it
    // until SKILL_LIST_TTL_SECONDS elapses.
    this.epochs.bumpGlobal();
    this.logger.info(
      { slug: skill.slug, from: current, to: target, forced: options?.skipEvalGate === true },
      "Skill lifecycle transitioned",
    );
    return updated;
  }

  /**
   * P1-12 stage 3 — publish-time eval regression gate. Throws
   * `EvalRegressionError` when at least one case is failing or untested for
   * the skill's *current* version. A skill with zero persisted cases passes
   * the gate trivially — opting in to evals is the user's choice, not the
   * platform's mandate. We also count `error`-status runs as untested
   * because a provider crash leaves us with no signal about the case's
   * behaviour.
   */
  private assertEvalRegressionGate(skill: SkillMeta): void {
    const evalRepo = this.evalRepo;
    if (!evalRepo) return;
    const cases = evalRepo.findCasesBySkillId(skill.id);
    if (cases.length === 0) return;
    const latest = evalRepo.findLatestRunStatusByCase(skill.id, skill.version);
    const failing: string[] = [];
    const untested: string[] = [];
    for (const c of cases) {
      const status = latest.get(c.caseName);
      if (status === undefined) untested.push(c.caseName);
      else if (status !== "pass") failing.push(c.caseName);
    }
    if (failing.length === 0 && untested.length === 0) return;
    this.logger.warn(
      { slug: skill.slug, version: skill.version, failing, untested },
      "Eval regression gate refused publish",
    );
    throw new EvalRegressionError(skill.slug, skill.version, failing, untested);
  }

  /** Returns the legal next states for a skill, used by admin UIs to render allowed actions. */
  async getNextLifecycleStates(identifier: string): Promise<{ current: SkillStatus; next: SkillStatus[] }> {
    const skill = await this.resolveSkill(identifier);
    if (!skill) throw new SkillNotFoundError(identifier);
    const current = (skill.status ?? "draft") as SkillStatus;
    return { current, next: nextStates(current) };
  }

  // ===== P0-A — admin convergence layer ======================================
  // Admin handlers must not call `skillRepo` / `storage` / `importer` directly.
  // The methods below own (1) cache invalidation via eventBus -> CacheSubscriber,
  // (2) request-body field allowlisting (storagePath / contentHash kept system-
  // managed), and (3) audit-log access. Refactor target: review §4.1.

  /** Admin list (no permission filter; admin sees all visibility states). */
  async adminListSkills(opts?: ListSkillsOptions): Promise<SkillMetaPublic[]> {
    if (!this.skillRepo) throw new ConfigurationError("Skill repository not configured");
    const skills = await this.skillRepo.findAll({
      category: opts?.category,
      tags: opts?.tags,
      attributes: opts?.attributes,
    });
    return skills.map(toSkillMetaPublic);
  }

  /** Admin lookup by skill `name` (returns DTO array). */
  async adminFindSkillsByName(name: string): Promise<SkillMetaPublic[]> {
    if (!this.skillRepo) throw new ConfigurationError("Skill repository not configured");
    const skills = await this.skillRepo.findByName(name);
    return skills.map(toSkillMetaPublic);
  }

  /** Admin lookup by slug; throws SkillNotFoundError if absent. */
  async adminGetSkillBySlug(slug: string): Promise<SkillMetaPublic> {
    if (!this.skillRepo) throw new ConfigurationError("Skill repository not configured");
    const skill = await this.skillRepo.findBySlug(slug);
    if (!skill) throw new SkillNotFoundError(slug);
    return toSkillMetaPublic(skill);
  }

  /** Admin update — projects request body to ADMIN_PUT_ALLOWED, publishes skill:updated. */
  async adminUpdateSkill(slug: string, body: Record<string, unknown>): Promise<SkillMetaPublic> {
    if (!this.skillRepo) throw new ConfigurationError("Skill repository not configured");
    const skill = await this.skillRepo.findBySlug(slug);
    if (!skill) throw new SkillNotFoundError(slug);
    const projected: Record<string, unknown> = {};
    for (const key of ADMIN_PUT_ALLOWED) {
      if (key in body) projected[key] = body[key];
    }
    const updated = await this.skillRepo.update(skill.id, projected);
    if (this.eventBus) {
      this.eventBus.publish({
        type: "skill:updated",
        slug,
        visibility: updated?.visibility ?? skill.visibility,
        tags: updated?.tags ?? skill.tags,
      });
    }
    if (!updated) throw new SkillNotFoundError(slug);
    return toSkillMetaPublic(updated);
  }

  /** Admin delete — storage.deleteDir before skillRepo.delete (order matters: live tree removed before row); publishes skill:deleted. */
  async adminDeleteSkill(slug: string): Promise<void> {
    if (!this.skillRepo || !this.storage) {
      throw new ConfigurationError("Skill repository or storage not configured");
    }
    const skill = await this.skillRepo.findBySlug(slug);
    if (!skill) throw new SkillNotFoundError(slug);
    await this.storage.deleteDir(skill.storagePath);
    const deleted = await this.skillRepo.delete(slug);
    if (this.eventBus) {
      this.eventBus.publish({
        type: "skill:deleted",
        slug,
        visibility: skill.visibility,
        tags: skill.tags,
      });
    }
    if (!deleted) throw new SkillNotFoundError(slug);
  }

  /** Admin entry — raw SKILL.md without permission filter. */
  async adminGetEntry(slug: string): Promise<string> {
    return this.skillProvider.getSkillEntry(slug);
  }

  /** Admin batch file read — bypass permission filter (admin already gated at HTTP). */
  async adminGetFiles(slug: string, paths: string[]): Promise<SkillFileContent[]> {
    return this.skillProvider.getSkillFiles(slug, paths);
  }

  /** Admin file tree — bypass permission filter. */
  async adminGetFileTree(slug: string): Promise<FileInfo[]> {
    return this.skillProvider.getSkillFileTree(slug);
  }

  /** Admin total skill count for stats. */
  async adminCountSkills(): Promise<number> {
    if (!this.skillRepo) throw new ConfigurationError("Skill repository not configured");
    return this.skillRepo.count();
  }

  /** Admin access-log lookup — caps `limit` at the call site; this just reads. */
  async adminFindAccessLogs(slug: string, limit: number): Promise<AccessLogEntry[]> {
    if (!this.accessLogRepo) throw new ConfigurationError("Access log repository not configured");
    return this.accessLogRepo.findBySkill(slug, limit);
  }

  /** Admin import — delegates to SkillImporter; importer publishes its own events post-commit. */
  async adminImportSkill(source: string, opts: ImportOptions): Promise<ImportResult> {
    if (!this.importer) throw new ConfigurationError("Importer not configured");
    return this.importer.import(source, opts);
  }

  /** Admin rollback — wraps `rollbackToVersion` and publishes skill:updated using post-rollback metadata. */
  async adminRollbackToVersion(
    slug: string,
    targetVersion: string,
    bump: VersionBump = "patch",
  ): Promise<void> {
    await this.rollbackToVersion(slug, targetVersion, bump);
    if (!this.skillRepo) return;
    const skillAfter = await this.skillRepo.findBySlug(slug);
    if (this.eventBus) {
      this.eventBus.publish({
        type: "skill:updated",
        slug,
        visibility: skillAfter?.visibility,
        tags: skillAfter?.tags,
      });
    }
  }

  /**
   * P1-11 stage 2b — admin-only retrieval signal tuning. Lets ops adjust
   * `triggers` / `whenToUse` / `embeddingText` without re-importing the
   * package; the BM25 indexer picks up the new text via the `skill:updated`
   * event handler. Body shape mirrors {@link SkillRetrievalMeta}; fields
   * not present in the request body are left untouched.
   *
   * Pass `{ retrievalMeta: null }` to clear all three fields at once
   * (the importer treats null and "all-empty" identically — see
   * serializeRetrievalMeta).
   */
  async adminUpdateRetrievalMeta(
    slug: string,
    patch: SkillRetrievalMeta | null,
  ): Promise<SkillMetaPublic> {
    if (!this.skillRepo) throw new ConfigurationError("Skill repository not configured");
    const skill = await this.skillRepo.findBySlug(slug);
    if (!skill) throw new SkillNotFoundError(slug);

    let merged: SkillRetrievalMeta | null;
    if (patch === null) {
      merged = null;
    } else {
      const current = skill.retrievalMeta ?? {};
      merged = {
        ...current,
        ...(patch.triggers !== undefined ? { triggers: patch.triggers } : {}),
        ...(patch.whenToUse !== undefined ? { whenToUse: patch.whenToUse } : {}),
        ...(patch.embeddingText !== undefined ? { embeddingText: patch.embeddingText } : {}),
      };
    }

    // P1-11 — service-layer caps mirror the importer. A non-importer write
    // path (admin REST) MUST enforce the same limits or a malicious admin
    // could plant arbitrarily large blobs in the JSON column.
    if (merged) {
      if (merged.triggers !== undefined) {
        if (!Array.isArray(merged.triggers)) {
          throw new BadRequestError("triggers must be an array of strings");
        }
        if (merged.triggers.length > 32) {
          throw new BadRequestError("triggers exceeds max of 32 entries");
        }
        for (const t of merged.triggers) {
          if (typeof t !== "string") throw new BadRequestError("triggers entries must be strings");
          if (t.length > 128) throw new BadRequestError("triggers entry exceeds max of 128 chars");
        }
      }
      if (merged.whenToUse !== undefined) {
        if (typeof merged.whenToUse !== "string") {
          throw new BadRequestError("whenToUse must be a string");
        }
        if (merged.whenToUse.length > 2048) {
          throw new BadRequestError("whenToUse exceeds max of 2048 chars");
        }
      }
      if (merged.embeddingText !== undefined) {
        if (typeof merged.embeddingText !== "string") {
          throw new BadRequestError("embeddingText must be a string");
        }
        if (merged.embeddingText.length > 8192) {
          throw new BadRequestError("embeddingText exceeds max of 8192 chars");
        }
      }
    }

    const updated = await this.skillRepo.update(skill.id, { retrievalMeta: merged });
    if (!updated) throw new SkillNotFoundError(slug);
    if (this.eventBus) {
      this.eventBus.publish({
        type: "skill:updated",
        slug,
        visibility: updated.visibility,
        tags: updated.tags,
      });
    }
    return toSkillMetaPublic(updated);
  }

  /** Admin lifecycle transition — wraps `transitionLifecycle` and publishes skill:updated. */
  async adminTransitionLifecycle(
    slug: string,
    target: SkillStatus,
    options?: TransitionLifecycleOptions,
  ): Promise<SkillMeta> {
    const updated = await this.transitionLifecycle(slug, target, options);
    if (this.eventBus) {
      this.eventBus.publish({
        type: "skill:updated",
        slug,
        visibility: updated.visibility,
        tags: updated.tags,
      });
      if (target === "deprecated") {
        this.eventBus.publish({
          type: "skill:deprecated",
          slug,
          visibility: updated.visibility,
          tags: updated.tags,
          version: updated.version,
        });
      }
    }
    return updated;
  }
}

export { IllegalTransitionError };
