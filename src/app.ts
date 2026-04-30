import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { URL as URLParser } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { createMcpServer } from "./mcp/server.js";
import { getLogger } from "./utils/logger.js";
import { getConfig } from "./config/index.js";
import { createApiKeyAuthMiddleware } from "./middleware/apikey-auth.js";
import { createContextBuilder, extractBearerToken, buildRequestContextFromHttp } from "./permission/context-builder.js";
import { TagPermissionFilter } from "./permission/tag-filter.js";
import type { SkillService } from "./services/skill.service.js";
import type { ISkillProvider } from "./provider/interface.js";
import type { SkillRepository } from "./db/repositories/skill.repository.js";
import type { SkillFileRepository } from "./db/repositories/skill-file.repository.js";
import type { AccessLogRepository } from "./db/repositories/access-log.repository.js";
import type { UserRepository } from "./db/repositories/user.repository.js";
import type { RoleRepository } from "./db/repositories/role.repository.js";
import type { UserRoleRepository } from "./db/repositories/user-role.repository.js";
import type { SkillFeedbackRepository } from "./db/repositories/skill-feedback.repository.js";
import type { IStorageProvider } from "./storage/provider.interface.js";
import type { ICacheProvider } from "./cache/provider.interface.js";
import { SkillImporter } from "./import/importer.js";

const logger = getLogger();

export interface AppDependencies {
  skillService: SkillService;
  skillProvider: ISkillProvider;
  serverName: string;
  serverVersion: string;
  skillRepo: SkillRepository;
  skillFileRepo: SkillFileRepository;
  accessLogRepo: AccessLogRepository;
  storage: IStorageProvider;
  cache: ICacheProvider;
  importer: SkillImporter;
  userRepo?: UserRepository;
  roleRepo?: RoleRepository;
  userRoleRepo?: UserRoleRepository;
  feedbackRepo?: SkillFeedbackRepository;
}

export interface TransportConfig {
  type: "sse" | "http";
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function getSafeHost(headerHost: string | undefined): string {
  // Use X-Forwarded-Host if behind proxy, otherwise use Host header
  const host = headerHost ?? "localhost";
  // Validate host format to prevent header injection
  if (!/^[a-zA-Z0-9:.-]+$/.test(host)) {
    return "localhost";
  }
  return host;
}

function isValidSlug(slug: string): boolean {
  // Allow alphanumeric, hyphens, underscores (skill slugs)
  // Reject anything with path traversal patterns
  if (!slug || slug.length > 255) return false;
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..") || slug.includes("~")) return false;
  return /^[a-zA-Z0-9_-]+$/.test(slug);
}

function parsePagination(url: string, headers: Record<string, string | undefined>): { offset: number; limit: number } {
  const safeHost = getSafeHost(headers.host);
  const urlObj = new URLParser(url, `http://${safeHost}`);
  const offset = Math.max(0, parseInt(urlObj.searchParams.get("offset") ?? "0", 10));
  const limit = Math.min(100, Math.max(1, parseInt(urlObj.searchParams.get("limit") ?? "50", 10)));
  return { offset, limit };
}

export async function createApp(
  deps: AppDependencies,
  transportConfig: TransportConfig,
): Promise<Server> {
  const httpServer = createServer();
  const appConfig = getConfig();

  // =========================================================
  // MCP Transport setup
  // =========================================================
  let mcpHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;

  const isCloudServiceOnlyMode = appConfig.deployment.mode === "cloud-service-only";
  const contextBuilder = deps.userRepo && deps.userRoleRepo
    ? createContextBuilder(deps.userRepo, deps.userRoleRepo)
    : undefined;

  if (isCloudServiceOnlyMode) {
    logger.info("Cloud Service only mode: MCP transport disabled");
  } else if (transportConfig.type === "http") {
    const mcpServer = await createMcpServer(
      deps.skillService,
      deps.skillProvider,
      deps.serverName,
      deps.serverVersion,
      contextBuilder,
    );
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await mcpServer.connect(transport);

    mcpHandler = async (req, res) => {
      await transport.handleRequest(req, res);
    };

    logger.info("Streamable HTTP transport configured at /mcp");
  } else if (transportConfig.type === "sse") {
    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
    const sseTransports = new Map<string, InstanceType<typeof SSEServerTransport>>();

    mcpHandler = async (req, res) => {
      const url = req.url?.split("?")[0] ?? "";

      if (req.method === "GET" && url === "/mcp/sse") {
        const sessionId = crypto.randomUUID();
        logger.info({ sessionId }, "SSE connection requested");

        const server = await createMcpServer(
          deps.skillService,
          deps.skillProvider,
          deps.serverName,
          deps.serverVersion,
          contextBuilder,
        );
        const transport = new SSEServerTransport("/mcp/messages", res);
        sseTransports.set(sessionId, transport);

        await server.connect(transport);

        req.on("close", () => {
          sseTransports.delete(sessionId);
          server.close().catch(() => {});
          logger.info({ sessionId }, "SSE connection closed");
        });
        return;
      }

      if (req.method === "POST" && url === "/mcp/messages") {
        const urlObj = new URLParser(req.url ?? "/", `http://${req.headers.host}`);
        const sessionId = urlObj.searchParams.get("sessionId");

        if (sessionId && sseTransports.has(sessionId)) {
          await sseTransports.get(sessionId)!.handlePostMessage(req, res);
          return;
        }

        if (sseTransports.size === 1) {
          await sseTransports.values().next().value!.handlePostMessage(req, res);
          return;
        }

        json(res, 400, { error: "No active SSE session" });
        return;
      }
    };

    logger.info("SSE transport configured at /mcp/sse");
  }

  // =========================================================
  // Request router
  // =========================================================
  const apiKeyAuth = createApiKeyAuthMiddleware(appConfig.apiKey ?? { enabled: false, keys: [] });

  httpServer.on("request", async (req, res) => {
    try {
      const url = req.url?.split("?")[0] ?? "";

      // MCP routes → SDK transport (raw streams, no body consumption)
      if (url === "/mcp" || url === "/mcp/sse" || url === "/mcp/messages") {
        if (mcpHandler) {
          await mcpHandler(req, res);
          return;
        } else if (isCloudServiceOnlyMode) {
          json(res, 403, { error: "MCP not available in cloud-service-only mode" });
          return;
        }
      }

      // If MCP-only mode, reject all non-MCP routes
      if (appConfig.transport.mcpOnlyMode) {
        json(res, 404, { error: "Not found (MCP-only mode)" });
        return;
      }

      // Gateway API routes (require authentication if enabled)
      if (url.startsWith("/api/gateway/")) {
        const authed = await apiKeyAuth(req, res);
        if (!authed) return;
        await handleGatewayRoute(req, res, deps);
        return;
      }

      // Admin API routes (internal use, no auth required)
      if (url.startsWith("/api/admin/")) {
        await handleAdminRoute(req, res, deps);
        return;
      }

      // Legacy /api/health endpoint for backward compatibility
      if (url === "/api/health") {
        json(res, 200, { status: "ok", timestamp: new Date().toISOString() });
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (err) {
      logger.error({ err, url: req.url }, "Request handler error");
      if (!res.headersSent) {
        json(res, 500, { error: "Internal server error" });
      }
    }
  });

  return httpServer;
}

async function handleAdminRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AppDependencies,
): Promise<void> {
  const { skillRepo, skillProvider, accessLogRepo, storage, cache, importer } = deps;
  const url = req.url?.split("?")[0] ?? "";
  const safeHost = getSafeHost(req.headers.host);
  const urlObj = new URLParser(req.url ?? "/", `http://${safeHost}`);

  // List skills (with pagination + attributes filtering)
  if (req.method === "GET" && url === "/api/admin/skills") {
    const category = urlObj.searchParams.get("category") ?? undefined;
    const tags = urlObj.searchParams.get("tags")?.split(",").filter(Boolean);
    const { offset, limit } = parsePagination(req.url ?? "/", req.headers as Record<string, string | undefined>);

    // Collect attributes.* filters
    const attributes: Record<string, string> = {};
    for (const [key, value] of urlObj.searchParams) {
      if (key.startsWith("attributes.")) {
        attributes[key.slice("attributes.".length)] = value;
      }
    }

    const skills = await skillRepo.findAll({
      category,
      tags,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    });

    // Apply pagination
    const paginated = skills.slice(offset, offset + limit);
    json(res, 200, {
      success: true,
      data: paginated,
      total: skills.length,
      offset,
      limit,
    });
    return;
  }

  // Get skill by slug
  const slugMatch = url.match(/^\/api\/admin\/skills\/([^/]+)$/);
  if (slugMatch) {
    const slug = decodeURIComponent(slugMatch[1]);
    if (!isValidSlug(slug)) {
      json(res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }

    if (req.method === "GET") {
      const skill = await skillRepo.findBySlug(slug);
      if (!skill) {
        json(res, 404, { success: false, error: "Skill not found" });
        return;
      }
      json(res, 200, { success: true, data: skill });
      return;
    }

    if (req.method === "DELETE") {
      const skill = await skillRepo.findBySlug(slug);
      if (!skill) {
        json(res, 404, { success: false, error: "Skill not found" });
        return;
      }
      // Delete files from storage
      await storage.deleteDir(skill.storagePath);
      const deleted = await skillRepo.delete(slug);
      await cache.clearByPrefix(`skill:entry:${slug}`);
      await cache.clearByPrefix(`skill:file:${slug}`);
      if (!deleted) {
        json(res, 404, { success: false, error: "Skill not found" });
        return;
      }
      json(res, 200, { success: true });
      return;
    }

    if (req.method === "PUT") {
      const body = await readBody(req);
      let data;
      try {
        data = JSON.parse(body.toString());
      } catch (err) {
        json(res, 400, { success: false, error: "Invalid JSON in request body" });
        return;
      }
      const skill = await skillRepo.findBySlug(slug);
      if (!skill) {
        json(res, 404, { success: false, error: "Skill not found" });
        return;
      }
      const updated = await skillRepo.update(skill.id, data);
      await cache.clearByPrefix(`skill:entry:${slug}`);
      await cache.clearByPrefix(`skill:file:${slug}`);
      json(res, 200, { success: true, data: updated });
      return;
    }
  }

  // Get skill entry file
  const entryMatch = url.match(/^\/api\/admin\/skills\/([^/]+)\/entry$/);
  if (entryMatch && req.method === "GET") {
    const slug = decodeURIComponent(entryMatch[1]);
    if (!isValidSlug(slug)) {
      json(res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    try {
      const content = await skillProvider.getSkillEntry(slug);
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(content);
    } catch (error) {
      if ((error as Error).constructor.name === "SkillNotFoundError") {
        json(res, 404, { success: false, error: "Skill not found" });
      } else {
        json(res, 500, { success: false, error: "Failed to read entry file" });
      }
    }
    return;
  }

  // Batch read skill files
  const filesMatch = url.match(/^\/api\/admin\/skills\/([^/]+)\/files$/);
  if (filesMatch && req.method === "POST") {
    const slug = decodeURIComponent(filesMatch[1]);
    if (!isValidSlug(slug)) {
      json(res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    const body = await readBody(req);
    let data: { paths?: string[] };
    try {
      data = JSON.parse(body.toString());
    } catch (err) {
      json(res, 400, { success: false, error: "Invalid JSON in request body" });
      return;
    }
    const { paths } = data;
    if (!Array.isArray(paths)) {
      json(res, 400, { success: false, error: "paths must be an array" });
      return;
    }
    try {
      const files = await skillProvider.getSkillFiles(slug, paths);
      json(res, 200, { success: true, data: files });
    } catch (error) {
      if ((error as Error).constructor.name === "SkillNotFoundError") {
        json(res, 404, { success: false, error: "Skill not found" });
      } else {
        json(res, 500, { success: false, error: "Failed to read files" });
      }
    }
    return;
  }

  // Get skill file tree
  const fileTreeMatch = url.match(/^\/api\/admin\/skills\/([^/]+)\/file-tree$/);
  if (fileTreeMatch && req.method === "GET") {
    const slug = decodeURIComponent(fileTreeMatch[1]);
    if (!isValidSlug(slug)) {
      json(res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    try {
      const tree = await skillProvider.getSkillFileTree(slug);
      json(res, 200, { success: true, data: tree });
    } catch (error) {
      if ((error as Error).constructor.name === "SkillNotFoundError") {
        json(res, 404, { success: false, error: "Skill not found" });
      } else {
        json(res, 500, { success: false, error: "Failed to get file tree" });
      }
    }
    return;
  }

  // Upload skill package
  if (req.method === "POST" && url === "/api/admin/skills") {
    const contentType = req.headers["content-type"] ?? "";
    let result;
    try {
      if (contentType.includes("multipart/form-data")) {
        // ZIP upload via multipart — not yet supported
        json(res, 400, { success: false, error: "ZIP upload not yet supported, use CLI import or JSON body with source path" });
        return;
      }

      // JSON body with source path for import
      const body = await readBody(req);
      let data;
      try {
        data = JSON.parse(body.toString());
      } catch (err) {
        json(res, 400, { success: false, error: "Invalid JSON in request body" });
        return;
      }
      if (!data.source) {
        json(res, 400, { success: false, error: "source is required" });
        return;
      }
      result = await importer.import(data.source, {
        category: data.category,
        tags: data.tags,
        description: data.description,
        targetId: data.target_id,
        versionBump: data.version_bump ?? "patch",
        overwrite: data.overwrite ?? false,
        branch: data.branch,
        subDir: data.sub_dir,
      });
    } catch (error) {
      const err = error as Error;
      const status = (err as { statusCode?: number }).statusCode ?? 400;
      json(res, status, { success: false, error: err.message });
      return;
    }
    json(res, 201, { success: true, data: result });
    return;
  }

  // Search by name
  const nameMatch = url.match(/^\/api\/admin\/skills\/name\/([^/]+)$/);
  if (nameMatch && req.method === "GET") {
    const name = decodeURIComponent(nameMatch[1]);
    const skills = await skillRepo.findByName(name);
    json(res, 200, { success: true, data: skills, total: skills.length });
    return;
  }

  // Access logs
  if (req.method === "GET" && url === "/api/admin/logs") {
    const skillSlug = urlObj.searchParams.get("skill_slug") ?? "";
    const limit = Math.min(200, Math.max(1, parseInt(urlObj.searchParams.get("limit") ?? "50", 10)));
    if (!skillSlug) {
      json(res, 400, { success: false, error: "skill_slug query parameter is required" });
      return;
    }
    const logs = await accessLogRepo.findBySkill(skillSlug, limit);
    json(res, 200, { success: true, data: logs, total: logs.length });
    return;
  }

  // Stats
  if (req.method === "GET" && url === "/api/admin/stats") {
    const total = await skillRepo.count();
    json(res, 200, { success: true, data: { totalSkills: total } });
    return;
  }

  // =========================================================
  // User management (Admin API)
  // =========================================================
  if (deps.userRepo && deps.roleRepo && deps.userRoleRepo) {
    const { userRepo, roleRepo, userRoleRepo } = deps;

    // List users
    if (req.method === "GET" && url === "/api/admin/users") {
      const users = await userRepo.findAll();
      json(res, 200, { success: true, data: users });
      return;
    }

    // Create user
    if (req.method === "POST" && url === "/api/admin/users") {
      const body = await readBody(req);
      let data: { name?: string; role_ids?: string[] };
      try { data = JSON.parse(body.toString()); } catch { json(res, 400, { success: false, error: "Invalid JSON" }); return; }
      const token = `sk-live-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const hash = createHash("sha256").update(token).digest("hex");
      const user = await userRepo.create({ name: data.name, token: hash });
      if (data.role_ids?.length) {
        await userRoleRepo.replaceUserRoles(user.id, data.role_ids);
      }
      const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);
      const roleIds = await userRoleRepo.findRoleIdsByUserId(user.id);
      const roleNames: string[] = [];
      for (const rid of roleIds) {
        const r = await roleRepo.findById(rid);
        if (r) roleNames.push(r.name);
      }
      json(res, 201, { success: true, data: { id: user.id, name: user.name, token, roles: roleNames, tags } });
      return;
    }

    // Get user by ID
    const userIdMatch = url.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userIdMatch) {
      const userId = decodeURIComponent(userIdMatch[1]);
      if (req.method === "GET") {
        const user = await userRepo.findById(userId);
        if (!user) { json(res, 404, { success: false, error: "User not found" }); return; }
        const tags = await userRoleRepo.getAggregatedTagsByUserId(userId);
        const roleIds = await userRoleRepo.findRoleIdsByUserId(userId);
        const roles: Array<{ id: string; name: string; tags: string[] }> = [];
        for (const rid of roleIds) {
          const r = await roleRepo.findById(rid);
          if (r) roles.push({ id: r.id, name: r.name, tags: r.tags });
        }
        json(res, 200, { success: true, data: { ...user, roles, tags } });
        return;
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        let data: { name?: string; status?: string };
        try { data = JSON.parse(body.toString()); } catch { json(res, 400, { success: false, error: "Invalid JSON" }); return; }
        const updated = await userRepo.update(userId, data);
        if (!updated) { json(res, 404, { success: false, error: "User not found" }); return; }
        json(res, 200, { success: true, data: updated });
        return;
      }
      if (req.method === "DELETE") {
        await userRoleRepo.deleteByUserId(userId);
        const deleted = await userRepo.delete(userId);
        if (!deleted) { json(res, 404, { success: false, error: "User not found" }); return; }
        json(res, 200, { success: true });
        return;
      }
    }

    // Assign roles to user
    const assignMatch = url.match(/^\/api\/admin\/users\/([^/]+)\/roles$/);
    if (assignMatch && req.method === "PUT") {
      const userId = decodeURIComponent(assignMatch[1]);
      const body = await readBody(req);
      let data: { role_ids: string[] };
      try { data = JSON.parse(body.toString()); } catch { json(res, 400, { success: false, error: "Invalid JSON" }); return; }
      const user = await userRepo.findById(userId);
      if (!user) { json(res, 404, { success: false, error: "User not found" }); return; }
      await userRoleRepo.replaceUserRoles(userId, data.role_ids ?? []);
      // Invalidate user's skill list cache
      await cache.delete(`skill:list:${userId}`);
      json(res, 200, { success: true });
      return;
    }

    // List roles
    if (req.method === "GET" && url === "/api/admin/roles") {
      const rolesList = await roleRepo.findAll();
      json(res, 200, { success: true, data: rolesList });
      return;
    }

    // Create role
    if (req.method === "POST" && url === "/api/admin/roles") {
      const body = await readBody(req);
      let data: { name: string; description?: string; tags: string[] };
      try { data = JSON.parse(body.toString()); } catch { json(res, 400, { success: false, error: "Invalid JSON" }); return; }
      if (!data.name || !data.tags) { json(res, 400, { success: false, error: "name and tags required" }); return; }
      const role = await roleRepo.create(data);
      json(res, 201, { success: true, data: role });
      return;
    }

    // Get/update/delete role by ID
    const roleIdMatch = url.match(/^\/api\/admin\/roles\/([^/]+)$/);
    if (roleIdMatch) {
      const roleId = decodeURIComponent(roleIdMatch[1]);
      if (req.method === "GET") {
        const role = await roleRepo.findById(roleId);
        if (!role) { json(res, 404, { success: false, error: "Role not found" }); return; }
        json(res, 200, { success: true, data: role });
        return;
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        let data: { name?: string; description?: string; tags?: string[] };
        try { data = JSON.parse(body.toString()); } catch { json(res, 400, { success: false, error: "Invalid JSON" }); return; }
        const updated = await roleRepo.update(roleId, data);
        if (!updated) { json(res, 404, { success: false, error: "Role not found" }); return; }
        // Invalidate caches for all users with this role
        const affectedUserIds = await userRoleRepo.findUserIdsByRoleId(roleId);
        for (const uid of affectedUserIds) {
          await cache.delete(`skill:list:${uid}`);
        }
        json(res, 200, { success: true, data: updated });
        return;
      }
      if (req.method === "DELETE") {
        await userRoleRepo.deleteByRoleId?.(roleId) ?? Promise.resolve();
        const deleted = await roleRepo.delete(roleId);
        if (!deleted) { json(res, 404, { success: false, error: "Role not found" }); return; }
        json(res, 200, { success: true });
        return;
      }
    }
  }

  // Effectiveness report
  if (req.method === "GET" && url === "/api/admin/skills/effectiveness-report") {
    const days = parseInt(urlObj.searchParams.get("days") ?? "30", 10);
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
    json(res, 200, { success: true, data: { report, generated_at: new Date().toISOString() } });
    return;
  }

  // 404 - should not reach here since routing is checked in createApp
  json(res, 404, { error: "Not found" });
}

async function handleGatewayRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AppDependencies,
): Promise<void> {
  const { skillRepo, skillProvider, storage, cache } = deps;
  const url = req.url?.split("?")[0] ?? "";
  const safeHost = getSafeHost(req.headers.host);
  const urlObj = new URLParser(req.url ?? "/", `http://${safeHost}`);

  // Build RequestContext for Gateway API
  let context: import("./types/index.js").RequestContext | undefined;
  if (deps.userRepo && deps.userRoleRepo) {
    const token = extractBearerToken(req.headers.authorization);
    const sessionId = (req.headers["x-session-id"] as string) || randomUUID();
    context = await buildRequestContextFromHttp(token, sessionId, deps.userRepo, deps.userRoleRepo);
  }

  logger.debug({ url, method: req.method }, "Gateway API route");

  // Health check
  if (req.method === "GET" && url === "/api/gateway/health") {
    json(res, 200, { status: "ok", timestamp: new Date().toISOString() });
    return;
  }

  // List skills (with pagination + attributes filtering + permission filtering)
  if (req.method === "GET" && url === "/api/gateway/skills") {
    const category = urlObj.searchParams.get("category") ?? undefined;
    const tags = urlObj.searchParams.get("tags")?.split(",").filter(Boolean);
    const { offset, limit } = parsePagination(req.url ?? "/", req.headers as Record<string, string | undefined>);

    const attributes: Record<string, string> = {};
    for (const [key, value] of urlObj.searchParams) {
      if (key.startsWith("attributes.")) {
        attributes[key.slice("attributes.".length)] = value;
      }
    }

    let skills = await skillRepo.findAll({
      category,
      tags,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    });

    // Apply permission filtering
    if (context) {
      const filter = new TagPermissionFilter(context);
      skills = await filter.filter(skills);
    }

    const paginated = skills.slice(offset, offset + limit);
    json(res, 200, {
      success: true,
      data: paginated,
      total: skills.length,
      offset,
      limit,
    });
    return;
  }

  // Get skill by slug or ID
  const slugMatch = url.match(/^\/api\/gateway\/skills\/([^/]+)$/);
  if (slugMatch && req.method === "GET") {
    const identifier = decodeURIComponent(slugMatch[1]);
    // Validate slug format to prevent injection
    if (!isValidSlug(identifier) && !/^[0-9a-f-]{36}$/i.test(identifier)) {
      json(res, 400, { success: false, error: "Invalid skill identifier" });
      return;
    }
    let skill = await skillRepo.findBySlug(identifier);
    if (!skill) {
      skill = await skillRepo.findById(identifier);
    }
    if (!skill) {
      json(res, 404, { success: false, error: "Skill not found" });
      return;
    }
    // Permission check
    if (context) {
      const filter = new TagPermissionFilter(context);
      if (!filter.canAccess(skill)) {
        json(res, 403, { success: false, error: "Access denied" });
        return;
      }
    }
    json(res, 200, { success: true, data: skill });
    return;
  }

  // Get skill entry file
  const entryMatch = url.match(/^\/api\/gateway\/skills\/([^/]+)\/entry$/);
  if (entryMatch && req.method === "GET") {
    const slug = decodeURIComponent(entryMatch[1]);
    if (!isValidSlug(slug)) {
      json(res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    // Permission check
    if (context) {
      const skill = await skillRepo.findBySlug(slug);
      if (!skill) { json(res, 404, { success: false, error: "Skill not found" }); return; }
      const filter = new TagPermissionFilter(context);
      if (!filter.canAccess(skill)) { json(res, 403, { success: false, error: "Access denied" }); return; }
    }
    try {
      const content = await skillProvider.getSkillEntry(slug);
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(content);
    } catch (error) {
      if ((error as Error).constructor.name === "SkillNotFoundError") {
        json(res, 404, { success: false, error: "Skill not found" });
      } else {
        json(res, 500, { success: false, error: "Failed to read entry file" });
      }
    }
    return;
  }

  // Batch read skill files
  const filesMatch = url.match(/^\/api\/gateway\/skills\/([^/]+)\/files$/);
  if (filesMatch && req.method === "POST") {
    const slug = decodeURIComponent(filesMatch[1]);
    if (!isValidSlug(slug)) {
      json(res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    // Permission check
    if (context) {
      const skill = await skillRepo.findBySlug(slug);
      if (!skill) { json(res, 404, { success: false, error: "Skill not found" }); return; }
      const filter = new TagPermissionFilter(context);
      if (!filter.canAccess(skill)) { json(res, 403, { success: false, error: "Access denied" }); return; }
    }
    const body = await readBody(req);
    let data: { paths?: string[] };
    try {
      data = JSON.parse(body.toString());
    } catch (err) {
      json(res, 400, { success: false, error: "Invalid JSON in request body" });
      return;
    }
    const { paths } = data;
    if (!Array.isArray(paths)) {
      json(res, 400, { success: false, error: "paths must be an array" });
      return;
    }
    try {
      const files = await skillProvider.getSkillFiles(slug, paths);
      json(res, 200, { success: true, data: files });
    } catch (error) {
      if ((error as Error).constructor.name === "SkillNotFoundError") {
        json(res, 404, { success: false, error: "Skill not found" });
      } else {
        json(res, 500, { success: false, error: "Failed to read files" });
      }
    }
    return;
  }

  // Get skill file tree
  const fileTreeMatch = url.match(/^\/api\/gateway\/skills\/([^/]+)\/file-tree$/);
  if (fileTreeMatch && req.method === "GET") {
    const slug = decodeURIComponent(fileTreeMatch[1]);
    if (!isValidSlug(slug)) {
      json(res, 400, { success: false, error: "Invalid skill slug" });
      return;
    }
    // Permission check
    if (context) {
      const skill = await skillRepo.findBySlug(slug);
      if (!skill) { json(res, 404, { success: false, error: "Skill not found" }); return; }
      const filter = new TagPermissionFilter(context);
      if (!filter.canAccess(skill)) { json(res, 403, { success: false, error: "Access denied" }); return; }
    }
    try {
      const tree = await skillProvider.getSkillFileTree(slug);
      json(res, 200, { success: true, data: tree });
    } catch (error) {
      if ((error as Error).constructor.name === "SkillNotFoundError") {
        json(res, 404, { success: false, error: "Skill not found" });
      } else {
        json(res, 500, { success: false, error: "Failed to get file tree" });
      }
    }
    return;
  }

  // Not found
  json(res, 404, { error: "Not found" });
}
