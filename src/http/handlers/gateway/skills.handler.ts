import { randomUUID } from "node:crypto";
import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { readBody, json, isValidSlug, parsePagination } from "../../helpers.js";
import { extractBearerToken, buildRequestContextFromHttp } from "../../../permission/context-builder.js";
import { TagPermissionFilter } from "../../../permission/tag-filter.js";
import type { RequestContext } from "../../../types/index.js";
import type { HttpContext } from "../../context.js";

async function buildContext(ctx: HttpContext, deps: AppDependencies): Promise<RequestContext | undefined> {
  if (!deps.userRepo || !deps.userRoleRepo) return undefined;
  const token = extractBearerToken(ctx.req.headers.authorization);
  const sessionId = (ctx.req.headers["x-session-id"] as string) || randomUUID();
  return buildRequestContextFromHttp(token, sessionId, deps.userRepo, deps.userRoleRepo);
}

export function registerGatewaySkillRoutes(router: Router, deps: AppDependencies): void {
  const { skillRepo, skillProvider } = deps;

  router.get("/api/gateway/health", async (ctx) => {
    json(ctx.res, 200, { status: "ok", timestamp: new Date().toISOString() });
  });

  router.get("/api/gateway/skills", async (ctx) => {
    const context = await buildContext(ctx, deps);
    const category = ctx.query.get("category") ?? undefined;
    const tags = ctx.query.get("tags")?.split(",").filter(Boolean);
    const { offset, limit } = parsePagination(ctx.query);

    const attributes: Record<string, string> = {};
    for (const [key, value] of ctx.query) {
      if (key.startsWith("attributes.")) {
        attributes[key.slice("attributes.".length)] = value;
      }
    }

    let skills = await skillRepo.findAll({
      category,
      tags,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    });

    if (context) {
      const filter = new TagPermissionFilter(context);
      skills = await filter.filter(skills);
    }

    const paginated = skills.slice(offset, offset + limit);
    json(ctx.res, 200, { success: true, data: paginated, total: skills.length, offset, limit });
  });

  router.get("/api/gateway/skills/:identifier", async (ctx) => {
    const context = await buildContext(ctx, deps);
    const identifier = ctx.params.identifier;
    if (!isValidSlug(identifier) && !/^[0-9a-f-]{36}$/i.test(identifier)) {
      json(ctx.res, 400, { success: false, error: "Invalid skill identifier" });
      return;
    }
    let skill = await skillRepo.findBySlug(identifier);
    if (!skill) {
      skill = await skillRepo.findById(identifier);
    }
    if (!skill) {
      json(ctx.res, 404, { success: false, error: "Skill not found" });
      return;
    }
    if (context) {
      const filter = new TagPermissionFilter(context);
      if (!filter.canAccess(skill)) {
        json(ctx.res, 403, { success: false, error: "Access denied" });
        return;
      }
    }
    json(ctx.res, 200, { success: true, data: skill });
  });

  router.get("/api/gateway/skills/:slug/entry", async (ctx) => {
    const context = await buildContext(ctx, deps);
    const slug = ctx.params.slug;
    if (!isValidSlug(slug)) {
      json(ctx.res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    if (context) {
      const skill = await skillRepo.findBySlug(slug);
      if (!skill) { json(ctx.res, 404, { success: false, error: "Skill not found" }); return; }
      const filter = new TagPermissionFilter(context);
      if (!filter.canAccess(skill)) { json(ctx.res, 403, { success: false, error: "Access denied" }); return; }
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

  router.post("/api/gateway/skills/:slug/files", async (ctx) => {
    const context = await buildContext(ctx, deps);
    const slug = ctx.params.slug;
    if (!isValidSlug(slug)) {
      json(ctx.res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    if (context) {
      const skill = await skillRepo.findBySlug(slug);
      if (!skill) { json(ctx.res, 404, { success: false, error: "Skill not found" }); return; }
      const filter = new TagPermissionFilter(context);
      if (!filter.canAccess(skill)) { json(ctx.res, 403, { success: false, error: "Access denied" }); return; }
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

  router.get("/api/gateway/skills/:slug/file-tree", async (ctx) => {
    const context = await buildContext(ctx, deps);
    const slug = ctx.params.slug;
    if (!isValidSlug(slug)) {
      json(ctx.res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    if (context) {
      const skill = await skillRepo.findBySlug(slug);
      if (!skill) { json(ctx.res, 404, { success: false, error: "Skill not found" }); return; }
      const filter = new TagPermissionFilter(context);
      if (!filter.canAccess(skill)) { json(ctx.res, 403, { success: false, error: "Access denied" }); return; }
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
}
