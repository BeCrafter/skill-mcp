import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { json, parsePagination, requireSlug, readJsonBody, requireFilePaths } from "../../helpers.js";
import { BadRequestError, SkillNotFoundError } from "../../../utils/errors.js";
import { toSkillMetaPublic } from "../../../types/index.js";

/**
 * Admin skill routes — handlers throw domain errors (BadRequestError,
 * SkillNotFoundError, …) which the router-level `errorMap` middleware
 * translates into HTTP responses. No try/catch in the happy path.
 */
export function registerAdminSkillRoutes(router: Router, deps: AppDependencies): void {
  const { skillRepo, skillProvider, storage, importer, accessLogRepo, eventBus } = deps;

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

    const skills = await skillRepo.findAll({
      category,
      tags,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    });

    const paginated = skills.slice(offset, offset + limit).map(toSkillMetaPublic);
    json(ctx.res, 200, { success: true, data: paginated, total: skills.length, offset, limit });
  });

  router.get("/api/admin/skills/effectiveness-report", async (ctx) => {
    const days = parseInt(ctx.query.get("days") ?? "30", 10);
    const rates = await deps.skillService.getEffectivenessRates(days);
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
    const skills = await skillRepo.findByName(name);
    json(ctx.res, 200, { success: true, data: skills.map(toSkillMetaPublic), total: skills.length });
  });

  router.get("/api/admin/skills/:slug", async (ctx) => {
    const slug = requireSlug(ctx);
    const skill = await skillRepo.findBySlug(slug);
    if (!skill) throw new SkillNotFoundError(slug);
    json(ctx.res, 200, { success: true, data: toSkillMetaPublic(skill) });
  });

  router.put("/api/admin/skills/:slug", async (ctx) => {
    const slug = requireSlug(ctx);
    const data = await readJsonBody<Record<string, unknown>>(ctx.req);
    const skill = await skillRepo.findBySlug(slug);
    if (!skill) throw new SkillNotFoundError(slug);
    // T-728 — project the request body to a known-safe allowlist before
    // forwarding to the repo. `storagePath` / `contentHash` are
    // system-managed (importer + rollback) and would let a privileged
    // caller redirect a skill at an arbitrary storage path; admin PUT
    // has no legitimate need to set them.
    const ADMIN_PUT_ALLOWED = [
      "description", "displayName", "version", "category",
      "attributes", "status", "visibility", "entryFile", "tags",
    ] as const;
    const projected: Record<string, unknown> = {};
    for (const key of ADMIN_PUT_ALLOWED) {
      if (key in data) projected[key] = data[key];
    }
    const updated = await skillRepo.update(skill.id, projected);
    // Publish post-update visibility/tags so cache subscriber can compute
    // the affected user set; falls back to current values when unchanged.
    eventBus.publish({
      type: "skill:updated",
      slug,
      visibility: updated?.visibility ?? skill.visibility,
      tags: updated?.tags ?? skill.tags,
    });
    json(ctx.res, 200, { success: true, data: updated ? toSkillMetaPublic(updated) : null });
  });

  router.delete("/api/admin/skills/:slug", async (ctx) => {
    const slug = requireSlug(ctx);
    const skill = await skillRepo.findBySlug(slug);
    if (!skill) throw new SkillNotFoundError(slug);
    await storage.deleteDir(skill.storagePath);
    const deleted = await skillRepo.delete(slug);
    eventBus.publish({ type: "skill:deleted", slug, visibility: skill.visibility, tags: skill.tags });
    if (!deleted) throw new SkillNotFoundError(slug);
    json(ctx.res, 200, { success: true });
  });

  router.get("/api/admin/skills/:slug/entry", async (ctx) => {
    const slug = requireSlug(ctx);
    const content = await skillProvider.getSkillEntry(slug);
    ctx.res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    ctx.res.end(content);
  });

  router.post("/api/admin/skills/:slug/files", async (ctx) => {
    const slug = requireSlug(ctx);
    const data = await readJsonBody<{ paths?: unknown }>(ctx.req);
    const paths = requireFilePaths(data.paths);
    const files = await skillProvider.getSkillFiles(slug, paths);
    json(ctx.res, 200, { success: true, data: files });
  });

  router.get("/api/admin/skills/:slug/file-tree", async (ctx) => {
    const slug = requireSlug(ctx);
    const tree = await skillProvider.getSkillFileTree(slug);
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
    const result = await importer.import(data.source, {
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
    const logs = await accessLogRepo.findBySkill(skillSlug, limit);
    json(ctx.res, 200, { success: true, data: logs, total: logs.length });
  });

  router.get("/api/admin/stats", async (ctx) => {
    const total = await skillRepo.count();
    json(ctx.res, 200, { success: true, data: { totalSkills: total } });
  });

  router.get("/api/admin/skills/:slug/versions", async (ctx) => {
    const slug = requireSlug(ctx);
    const limit = parseInt(ctx.query.get("limit") ?? "10", 10);
    const versions = await deps.skillService.getVersions(slug, limit);
    json(ctx.res, 200, { success: true, data: versions });
  });

  router.post("/api/admin/skills/:slug/rollback", async (ctx) => {
    const slug = requireSlug(ctx);
    const data = await readJsonBody<{ version?: string; bump?: "major" | "minor" | "patch" }>(ctx.req);
    if (!data.version) throw new BadRequestError("version is required");
    await deps.skillService.rollbackToVersion(slug, data.version, data.bump ?? "patch");
    const skillAfter = await skillRepo.findBySlug(slug);
    eventBus.publish({
      type: "skill:updated",
      slug,
      visibility: skillAfter?.visibility,
      tags: skillAfter?.tags,
    });
    json(ctx.res, 200, { success: true, message: `Rolled back to version ${data.version}` });
  });
}
