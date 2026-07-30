import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { json, isValidSlug, parsePagination, requireSlug, readJsonBody, requireFilePaths } from "../../helpers.js";
import { BadRequestError } from "../../../utils/errors.js";

/**
 * Gateway skill routes — delegate to SkillService so the per-user list
 * cache (`skill:list:${userId}`) and the unified TagPermissionFilter path
 * are reused. Handlers stay thin: validate input, dispatch, and let the
 * `errorMap` middleware (registered on the router) translate any thrown
 * AppError into the appropriate HTTP response. No try/catch needed in the
 * happy path.
 */
export function registerGatewaySkillRoutes(router: Router, deps: AppDependencies): void {
  const { skillService } = deps;

  router.get("/api/gateway/skills", async (ctx) => {
    const context = ctx.requestContext!;
    const category = ctx.query.get("category") ?? undefined;
    const tags = ctx.query.get("tags")?.split(",").filter(Boolean);
    const { offset, limit } = parsePagination(ctx.query);

    const attributes: Record<string, string> = {};
    for (const [key, value] of ctx.query) {
      if (key.startsWith("attributes.")) {
        attributes[key.slice("attributes.".length)] = value;
      }
    }

    const skills = await skillService.listAccessibleSkills(context, {
      category,
      tags,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    });

    const paginated = skills.slice(offset, offset + limit);
    json(ctx.res, 200, { success: true, data: paginated, total: skills.length, offset, limit });
  });

  // C2 remote-proxy: BM25 search delegated from MCP-only proxy instances.
  // RBAC and ranking are handled locally by the storage Registry (which has
  // the hydrated index and the user/role store). The proxy's `skill_search`
  // reaches this endpoint via RemoteSkillProvider.search.
  router.get("/api/gateway/skills/search", async (ctx) => {
    const context = ctx.requestContext!;
    const q = ctx.query.get("q") ?? "";
    if (q.trim().length === 0) throw new BadRequestError("Missing search query (q)");
    const limit = Math.min(parseInt(ctx.query.get("limit") ?? "20", 10) || 20, 50);
    const tags = ctx.query.get("tags")?.split(",").filter(Boolean);
    const hits = await skillService.searchAccessibleSkills(context, q, { limit, tags });
    json(ctx.res, 200, { success: true, data: hits, total: hits.length });
  });

  router.get("/api/gateway/skills/:identifier", async (ctx) => {
    const context = ctx.requestContext!;
    const identifier = ctx.params.identifier;
    if (!isValidSlug(identifier) && !/^[0-9a-f-]{36}$/i.test(identifier)) {
      throw new BadRequestError("Invalid skill identifier");
    }
    const skill = await skillService.getAccessibleSkillMeta(identifier, context);
    json(ctx.res, 200, { success: true, data: skill });
  });

  router.get("/api/gateway/skills/:slug/entry", async (ctx) => {
    const context = ctx.requestContext!;
    const slug = requireSlug(ctx);
    const content = await skillService.getAccessibleEntryRaw(slug, context);
    ctx.res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    ctx.res.end(content);
  });

  router.post("/api/gateway/skills/:slug/files", async (ctx) => {
    const context = ctx.requestContext!;
    const slug = requireSlug(ctx);
    const data = await readJsonBody<{ paths?: unknown }>(ctx.req);
    const paths = requireFilePaths(data.paths);
    const files = await skillService.readSkillFiles(slug, paths, context);
    json(ctx.res, 200, { success: true, data: files });
  });

  router.get("/api/gateway/skills/:slug/file-tree", async (ctx) => {
    const context = ctx.requestContext!;
    const slug = requireSlug(ctx);
    const tree = await skillService.getAccessibleFileTree(slug, context);
    json(ctx.res, 200, { success: true, data: tree });
  });
}
