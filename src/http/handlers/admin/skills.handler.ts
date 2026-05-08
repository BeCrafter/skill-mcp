import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { readBody, json, isValidSlug, parsePagination } from "../../helpers.js";

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

    const paginated = skills.slice(offset, offset + limit);
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
    json(ctx.res, 200, { success: true, data: skills, total: skills.length });
  });

  router.get("/api/admin/skills/:slug", async (ctx) => {
    const slug = ctx.params.slug;
    if (!isValidSlug(slug)) {
      json(ctx.res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    const skill = await skillRepo.findBySlug(slug);
    if (!skill) {
      json(ctx.res, 404, { success: false, error: "Skill not found" });
      return;
    }
    json(ctx.res, 200, { success: true, data: skill });
  });

  router.put("/api/admin/skills/:slug", async (ctx) => {
    const slug = ctx.params.slug;
    if (!isValidSlug(slug)) {
      json(ctx.res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    const body = await readBody(ctx.req);
    let data;
    try {
      data = JSON.parse(body.toString());
    } catch {
      json(ctx.res, 400, { success: false, error: "Invalid JSON in request body" });
      return;
    }
    const skill = await skillRepo.findBySlug(slug);
    if (!skill) {
      json(ctx.res, 404, { success: false, error: "Skill not found" });
      return;
    }
    const updated = await skillRepo.update(skill.id, data);
    eventBus.publish({ type: "skill:updated", slug });
    json(ctx.res, 200, { success: true, data: updated });
  });

  router.delete("/api/admin/skills/:slug", async (ctx) => {
    const slug = ctx.params.slug;
    if (!isValidSlug(slug)) {
      json(ctx.res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    const skill = await skillRepo.findBySlug(slug);
    if (!skill) {
      json(ctx.res, 404, { success: false, error: "Skill not found" });
      return;
    }
    await storage.deleteDir(skill.storagePath);
    const deleted = await skillRepo.delete(slug);
    eventBus.publish({ type: "skill:deleted", slug });
    if (!deleted) {
      json(ctx.res, 404, { success: false, error: "Skill not found" });
      return;
    }
    json(ctx.res, 200, { success: true });
  });

  router.get("/api/admin/skills/:slug/entry", async (ctx) => {
    const slug = ctx.params.slug;
    if (!isValidSlug(slug)) {
      json(ctx.res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    try {
      const content = await skillProvider.getSkillEntry(slug);
      ctx.res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      ctx.res.end(content);
    } catch (error) {
      if ((error as Error).constructor.name === "SkillNotFoundError") {
        json(ctx.res, 404, { success: false, error: "Skill not found" });
      } else {
        json(ctx.res, 500, { success: false, error: "Failed to read entry file" });
      }
    }
  });

  router.post("/api/admin/skills/:slug/files", async (ctx) => {
    const slug = ctx.params.slug;
    if (!isValidSlug(slug)) {
      json(ctx.res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    const body = await readBody(ctx.req);
    let data: { paths?: string[] };
    try {
      data = JSON.parse(body.toString());
    } catch {
      json(ctx.res, 400, { success: false, error: "Invalid JSON in request body" });
      return;
    }
    const { paths } = data;
    if (!Array.isArray(paths)) {
      json(ctx.res, 400, { success: false, error: "paths must be an array" });
      return;
    }
    try {
      const files = await skillProvider.getSkillFiles(slug, paths);
      json(ctx.res, 200, { success: true, data: files });
    } catch (error) {
      if ((error as Error).constructor.name === "SkillNotFoundError") {
        json(ctx.res, 404, { success: false, error: "Skill not found" });
      } else {
        json(ctx.res, 500, { success: false, error: "Failed to read files" });
      }
    }
  });

  router.get("/api/admin/skills/:slug/file-tree", async (ctx) => {
    const slug = ctx.params.slug;
    if (!isValidSlug(slug)) {
      json(ctx.res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    try {
      const tree = await skillProvider.getSkillFileTree(slug);
      json(ctx.res, 200, { success: true, data: tree });
    } catch (error) {
      if ((error as Error).constructor.name === "SkillNotFoundError") {
        json(ctx.res, 404, { success: false, error: "Skill not found" });
      } else {
        json(ctx.res, 500, { success: false, error: "Failed to get file tree" });
      }
    }
  });

  router.post("/api/admin/skills", async (ctx) => {
    const contentType = ctx.req.headers["content-type"] ?? "";
    if (contentType.includes("multipart/form-data")) {
      json(ctx.res, 400, { success: false, error: "ZIP upload not yet supported, use CLI import or JSON body with source path" });
      return;
    }
    const body = await readBody(ctx.req);
    let data;
    try {
      data = JSON.parse(body.toString());
    } catch {
      json(ctx.res, 400, { success: false, error: "Invalid JSON in request body" });
      return;
    }
    if (!data.source) {
      json(ctx.res, 400, { success: false, error: "source is required" });
      return;
    }
    try {
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
    } catch (error) {
      const err = error as Error;
      const status = (err as { statusCode?: number }).statusCode ?? 400;
      json(ctx.res, status, { success: false, error: err.message });
    }
  });

  router.get("/api/admin/logs", async (ctx) => {
    const skillSlug = ctx.query.get("skill_slug") ?? "";
    const limit = Math.min(200, Math.max(1, parseInt(ctx.query.get("limit") ?? "50", 10)));
    if (!skillSlug) {
      json(ctx.res, 400, { success: false, error: "skill_slug query parameter is required" });
      return;
    }
    const logs = await accessLogRepo.findBySkill(skillSlug, limit);
    json(ctx.res, 200, { success: true, data: logs, total: logs.length });
  });

  router.get("/api/admin/stats", async (ctx) => {
    const total = await skillRepo.count();
    json(ctx.res, 200, { success: true, data: { totalSkills: total } });
  });

  // Version management routes
  router.get("/api/admin/skills/:slug/versions", async (ctx) => {
    const slug = ctx.params.slug;
    if (!isValidSlug(slug)) {
      json(ctx.res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    try {
      const limit = parseInt(ctx.query.get("limit") ?? "10", 10);
      const versions = await deps.skillService.getVersions(slug, limit);
      json(ctx.res, 200, { success: true, data: versions });
    } catch (error) {
      const err = error as Error;
      if (err.constructor.name === "SkillNotFoundError") {
        json(ctx.res, 404, { success: false, error: "Skill not found" });
      } else {
        json(ctx.res, 500, { success: false, error: err.message });
      }
    }
  });

  router.post("/api/admin/skills/:slug/rollback", async (ctx) => {
    const slug = ctx.params.slug;
    if (!isValidSlug(slug)) {
      json(ctx.res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    const body = await readBody(ctx.req);
    let data: { version: string; bump?: "major" | "minor" | "patch" };
    try {
      data = JSON.parse(body.toString());
    } catch {
      json(ctx.res, 400, { success: false, error: "Invalid JSON in request body" });
      return;
    }
    if (!data.version) {
      json(ctx.res, 400, { success: false, error: "version is required" });
      return;
    }
    try {
      await deps.skillService.rollbackToVersion(slug, data.version, data.bump ?? "patch");
      eventBus.publish({ type: "skill:updated", slug });
      json(ctx.res, 200, { success: true, message: `Rolled back to version ${data.version}` });
    } catch (error) {
      const err = error as Error;
      json(ctx.res, 500, { success: false, error: err.message });
    }
  });
}
