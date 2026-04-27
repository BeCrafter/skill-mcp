import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { URL as URLParser } from "node:url";
import { createMcpServer } from "./mcp/server.js";
import { getLogger } from "./utils/logger.js";
import type { SkillService } from "./services/skill.service.js";
import type { ISkillProvider } from "./provider/interface.js";
import type { SkillRepository } from "./db/repositories/skill.repository.js";
import type { SkillFileRepository } from "./db/repositories/skill-file.repository.js";
import type { AccessLogRepository } from "./db/repositories/access-log.repository.js";
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

function parsePagination(url: string, headers: Record<string, string | undefined>): { offset: number; limit: number } {
  const urlObj = new URLParser(url, `http://${headers.host ?? "localhost"}`);
  const offset = Math.max(0, parseInt(urlObj.searchParams.get("offset") ?? "0", 10));
  const limit = Math.min(100, Math.max(1, parseInt(urlObj.searchParams.get("limit") ?? "50", 10)));
  return { offset, limit };
}

export async function createApp(
  deps: AppDependencies,
  transportConfig: TransportConfig,
): Promise<Server> {
  const httpServer = createServer();

  // =========================================================
  // MCP Transport setup
  // =========================================================
  let mcpHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;

  if (transportConfig.type === "http") {
    const mcpServer = await createMcpServer(
      deps.skillService,
      deps.skillProvider,
      deps.serverName,
      deps.serverVersion,
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
  }

  if (transportConfig.type === "sse") {
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
  httpServer.on("request", async (req, res) => {
    try {
      const url = req.url?.split("?")[0] ?? "";

      // MCP routes → SDK transport (raw streams, no body consumption)
      if (mcpHandler && (url === "/mcp" || url === "/mcp/sse" || url === "/mcp/messages")) {
        await mcpHandler(req, res);
        return;
      }

      // Admin API routes
      await handleAdminRoute(req, res, deps);
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
  const urlObj = new URLParser(req.url ?? "/", `http://${req.headers.host}`);

  // Health check
  if (req.method === "GET" && url === "/api/health") {
    json(res, 200, { status: "ok", timestamp: new Date().toISOString() });
    return;
  }

  // List skills (with pagination + attributes filtering)
  if (req.method === "GET" && url === "/api/skills") {
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
  const slugMatch = url.match(/^\/api\/skills\/([^/]+)$/);
  if (slugMatch) {
    const slug = decodeURIComponent(slugMatch[1]);

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
      const data = JSON.parse(body.toString());
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
  const entryMatch = url.match(/^\/api\/skills\/([^/]+)\/entry$/);
  if (entryMatch && req.method === "GET") {
    const slug = decodeURIComponent(entryMatch[1]);
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
  const filesMatch = url.match(/^\/api\/skills\/([^/]+)\/files$/);
  if (filesMatch && req.method === "POST") {
    const slug = decodeURIComponent(filesMatch[1]);
    const body = await readBody(req);
    const { paths } = JSON.parse(body.toString()) as { paths: string[] };
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
  const fileTreeMatch = url.match(/^\/api\/skills\/([^/]+)\/file-tree$/);
  if (fileTreeMatch && req.method === "GET") {
    const slug = decodeURIComponent(fileTreeMatch[1]);
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
  if (req.method === "POST" && url === "/api/skills") {
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
      const data = JSON.parse(body.toString());
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
  const nameMatch = url.match(/^\/api\/skills\/name\/([^/]+)$/);
  if (nameMatch && req.method === "GET") {
    const name = decodeURIComponent(nameMatch[1]);
    const skills = await skillRepo.findByName(name);
    json(res, 200, { success: true, data: skills, total: skills.length });
    return;
  }

  // Access logs
  if (req.method === "GET" && url === "/api/logs") {
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
  if (req.method === "GET" && url === "/api/stats") {
    const total = await skillRepo.count();
    json(res, 200, { success: true, data: { totalSkills: total } });
    return;
  }

  // Not found
  json(res, 404, { error: "Not found" });
}
