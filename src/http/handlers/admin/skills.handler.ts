import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { json, parsePagination, requireSlug, readJsonBody, requireFilePaths } from "../../helpers.js";
import { BadRequestError } from "../../../utils/errors.js";
import { toSkillMetaPublic, type SkillStatus } from "../../../types/index.js";

// P0-9 — published lifecycle transitions exposed at the HTTP layer. Each verb
// names its target state explicitly (rather than a generic PATCH ?status=…)
// so audit logs and API gateways can authorize by route alone.
const LIFECYCLE_VERBS: Record<string, SkillStatus> = {
  publish: "published",
  deprecate: "deprecated",
  archive: "archived",
  republish: "published",
};

/**
 * Admin skill routes — handlers throw domain errors (BadRequestError,
 * SkillNotFoundError, …) which the router-level `errorMap` middleware
 * translates into HTTP responses. No try/catch in the happy path.
 *
 * P0-A — every route delegates to `skillService.admin*`; cache invalidation,
 * event publication, body allowlisting, and storage cleanup are owned by the
 * service layer (review §4.1). This handler is a thin parameter-extraction
 * shim — repos/storage/importer/eventBus are deliberately not destructured.
 */
export function registerAdminSkillRoutes(router: Router, deps: AppDependencies): void {
  const { skillService } = deps;

  router.get("/api/admin/skills", async (ctx) => {
    const category = ctx.query.get("category") ?? undefined;
    const tags = ctx.query.get("tags")?.split(",").filter(Boolean);
    const { offset, limit } = parsePagination(ctx.query);

    const attributes: Record<string, string> = {};
    for (const [key, value] of ctx.query) {
      if (key.startsWith("attributes.")) {
        attributes[key.slice("attributes.".length)] = value;
      }
    }

    const skills = await skillService.adminListSkills({
      category,
      tags,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    });

    const paginated = skills.slice(offset, offset + limit);
    json(ctx.res, 200, { success: true, data: paginated, total: skills.length, offset, limit });
  });

  router.get("/api/admin/skills/effectiveness-report", async (ctx) => {
    const days = parseInt(ctx.query.get("days") ?? "30", 10);
    const rates = await skillService.getEffectivenessRates(days);
    const report = [];
    for (const [slug, { rate, count }] of rates) {
      let recommendation: string;
      if (rate >= 0.8) recommendation = "Performing well";
      else if (rate >= 0.5) recommendation = "Needs attention";
      else if (count >= 10) recommendation = "Consider deprecating or rewriting";
      else recommendation = "Insufficient data, continue monitoring";
      report.push({ slug, effectiveness: Math.round(rate * 100) / 100, feedback_count: count, recommendation });
    }
    json(ctx.res, 200, { success: true, data: { report, generated_at: new Date().toISOString() } });
  });

  router.get("/api/admin/skills/name/:name", async (ctx) => {
    const name = ctx.params.name;
    const skills = await skillService.adminFindSkillsByName(name);
    json(ctx.res, 200, { success: true, data: skills, total: skills.length });
  });

  router.get("/api/admin/skills/:slug", async (ctx) => {
    const slug = requireSlug(ctx);
    const skill = await skillService.adminGetSkillBySlug(slug);
    json(ctx.res, 200, { success: true, data: skill });
  });

  router.put("/api/admin/skills/:slug", async (ctx) => {
    const slug = requireSlug(ctx);
    const data = await readJsonBody<Record<string, unknown>>(ctx.req);
    const updated = await skillService.adminUpdateSkill(slug, data);
    json(ctx.res, 200, { success: true, data: updated });
  });

  // P1-11 stage 2b — manual retrieval-signal tuning. Lets ops adjust
  // triggers / when_to_use / embedding_text without re-importing the
  // package; the BM25 indexer picks up the new text via the skill:updated
  // event handler. Body shape mirrors `SkillRetrievalMeta` (camelCase or
  // snake_case both accepted); send `null` to clear all three fields.
  router.put("/api/admin/skills/:slug/retrieval", async (ctx) => {
    const slug = requireSlug(ctx);
    const raw = await readJsonBody<Record<string, unknown> | null>(ctx.req);
    const normalised = raw === null ? null : {
      ...(raw.triggers !== undefined ? { triggers: raw.triggers as string[] | undefined } : {}),
      ...(raw.when_to_use !== undefined ? { whenToUse: raw.when_to_use as string | undefined } : {}),
      ...(raw.whenToUse !== undefined ? { whenToUse: raw.whenToUse as string | undefined } : {}),
      ...(raw.embedding_text !== undefined ? { embeddingText: raw.embedding_text as string | undefined } : {}),
      ...(raw.embeddingText !== undefined ? { embeddingText: raw.embeddingText as string | undefined } : {}),
    };
    const updated = await skillService.adminUpdateRetrievalMeta(slug, normalised);
    json(ctx.res, 200, { success: true, data: updated });
  });

  router.delete("/api/admin/skills/:slug", async (ctx) => {
    const slug = requireSlug(ctx);
    await skillService.adminDeleteSkill(slug);
    json(ctx.res, 200, { success: true });
  });

  router.get("/api/admin/skills/:slug/entry", async (ctx) => {
    const slug = requireSlug(ctx);
    const content = await skillService.adminGetEntry(slug);
    ctx.res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    ctx.res.end(content);
  });

  router.post("/api/admin/skills/:slug/files", async (ctx) => {
    const slug = requireSlug(ctx);
    const data = await readJsonBody<{ paths?: unknown }>(ctx.req);
    const paths = requireFilePaths(data.paths);
    const files = await skillService.adminGetFiles(slug, paths);
    json(ctx.res, 200, { success: true, data: files });
  });

  router.get("/api/admin/skills/:slug/file-tree", async (ctx) => {
    const slug = requireSlug(ctx);
    const tree = await skillService.adminGetFileTree(slug);
    json(ctx.res, 200, { success: true, data: tree });
  });

  router.post("/api/admin/skills", async (ctx) => {
    const contentType = ctx.req.headers["content-type"] ?? "";
    if (contentType.includes("multipart/form-data")) {
      throw new BadRequestError("ZIP upload not yet supported, use CLI import or JSON body with source path");
    }
    const data = await readJsonBody<{
      source?: string;
      category?: string;
      tags?: string[];
      description?: string;
      target_id?: string;
      version_bump?: "major" | "minor" | "patch";
      overwrite?: boolean;
      allow_duplicate?: boolean;
      slug?: string;
      branch?: string;
      sub_dir?: string;
    }>(ctx.req);
    if (!data.source) throw new BadRequestError("source is required");
    const result = await skillService.adminImportSkill(data.source, {
      category: data.category,
      tags: data.tags,
      description: data.description,
      targetId: data.target_id,
      versionBump: data.version_bump ?? "patch",
      overwrite: data.overwrite ?? false,
      allowDuplicate: data.allow_duplicate ?? false,
      slug: data.slug,
      branch: data.branch,
      subDir: data.sub_dir,
    });
    json(ctx.res, 201, { success: true, data: result });
  });

  router.get("/api/admin/logs", async (ctx) => {
    const skillSlug = ctx.query.get("skill_slug") ?? "";
    const limit = Math.min(200, Math.max(1, parseInt(ctx.query.get("limit") ?? "50", 10)));
    if (!skillSlug) throw new BadRequestError("skill_slug query parameter is required");
    const logs = await skillService.adminFindAccessLogs(skillSlug, limit);
    json(ctx.res, 200, { success: true, data: logs, total: logs.length });
  });

  router.get("/api/admin/stats", async (ctx) => {
    const total = await skillService.adminCountSkills();
    json(ctx.res, 200, { success: true, data: { totalSkills: total } });
  });

  router.get("/api/admin/skills/:slug/versions", async (ctx) => {
    const slug = requireSlug(ctx);
    const limit = parseInt(ctx.query.get("limit") ?? "10", 10);
    const versions = await skillService.getVersions(slug, limit);
    json(ctx.res, 200, { success: true, data: versions });
  });

  router.get("/api/admin/skills/:slug/lifecycle/next", async (ctx) => {
    const slug = requireSlug(ctx);
    const result = await skillService.getNextLifecycleStates(slug);
    json(ctx.res, 200, { success: true, data: result });
  });

  for (const [verb, target] of Object.entries(LIFECYCLE_VERBS)) {
    router.post(`/api/admin/skills/:slug/${verb}`, async (ctx) => {
      const slug = requireSlug(ctx);
      // P1-12 stage 3 — `?force=true` bypasses the publish-time eval
      // regression gate. Only meaningful for publish + republish targets;
      // deprecate/archive paths ignore the flag because the gate doesn't run.
      const force = ctx.query.get("force") === "true";
      const updated = await skillService.adminTransitionLifecycle(slug, target, { skipEvalGate: force });
      json(ctx.res, 200, { success: true, data: toSkillMetaPublic(updated) });
    });
  }

  router.post("/api/admin/skills/:slug/rollback", async (ctx) => {
    const slug = requireSlug(ctx);
    const data = await readJsonBody<{ version?: string; bump?: "major" | "minor" | "patch" }>(ctx.req);
    if (!data.version) throw new BadRequestError("version is required");
    await skillService.adminRollbackToVersion(slug, data.version, data.bump ?? "patch");
    json(ctx.res, 200, { success: true, message: `Rolled back to version ${data.version}` });
  });
}
