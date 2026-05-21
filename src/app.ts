import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createMcpServer } from "./mcp/server.js";
import { getLogger } from "./utils/logger.js";
import { getConfig } from "./config/index.js";
import { createContextBuilder } from "./permission/context-builder.js";
import { Router } from "./http/router.js";
import { json, parseQuery } from "./http/helpers.js";
import { attachRequestId } from "./http/middleware/request-id.js";
import { registry, metrics } from "./telemetry/metrics.js";
import { registerAdminSkillRoutes } from "./http/handlers/admin/skills.handler.js";
import { registerAdminUserRoutes } from "./http/handlers/admin/users.handler.js";
import { registerAdminRoleRoutes } from "./http/handlers/admin/roles.handler.js";
import { registerGatewaySkillRoutes } from "./http/handlers/gateway/skills.handler.js";
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
import { DomainEventBus } from "./events/event-bus.js";
import { setupCacheSubscribers } from "./events/cache-subscriber.js";
import type { HttpContext } from "./http/context.js";

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
  eventBus: DomainEventBus;
  userRepo?: UserRepository;
  roleRepo?: RoleRepository;
  userRoleRepo?: UserRoleRepository;
  feedbackRepo?: SkillFeedbackRepository;
}

export interface TransportConfig {
  type: "sse" | "http";
}

export async function createApp(
  deps: AppDependencies,
  transportConfig: TransportConfig,
): Promise<Server> {
  const httpServer = createServer();
  const appConfig = getConfig();

  // Event-driven cache invalidation
  setupCacheSubscribers(deps.eventBus, deps.cache);

  // MCP Transport setup
  let mcpHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
  const isCloudServiceOnlyMode = appConfig.deployment.mode === "cloud";
  const contextBuilder = deps.userRepo && deps.userRoleRepo
    ? createContextBuilder(deps.userRepo, deps.userRoleRepo)
    : undefined;

  if (isCloudServiceOnlyMode) {
    logger.info("Cloud Service only mode: MCP transport disabled");
  } else if (transportConfig.type === "http") {
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

    // Map to track active sessions, similar to SSE but for StreamableHttp
    const httpSessions = new Map<string, { transport: InstanceType<typeof StreamableHTTPServerTransport>; server: Awaited<ReturnType<typeof createMcpServer>> }>();

    mcpHandler = async (req, res) => {
      // Read body first - required because getRequestListener from @hono/node-server
      // sets wrapBodyStream AFTER newRequest is called, so passing req directly
      // results in a Request with no body and req.json() hangs indefinitely.
      let parsedBody: unknown;
      if (req.method === "POST") {
        const rawBody = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.on("data", chunk => { data += chunk; });
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });
        try { parsedBody = JSON.parse(rawBody); } catch { /* will be rejected by transport */ }
      }

      // Use mcp-session-id from request header (MCP spec), or generate new UUID for new sessions
      const sessionId = (req.headers["mcp-session-id"] as string) || crypto.randomUUID();

      try {
        if (!httpSessions.has(sessionId)) {
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId, enableJsonResponse: true });
          const server = await createMcpServer(deps.skillService, deps.skillProvider, deps.serverName, deps.serverVersion, contextBuilder);
          await server.connect(transport);
          httpSessions.set(sessionId, { transport, server });
          req.on("close", () => {
            const session = httpSessions.get(sessionId);
            httpSessions.delete(sessionId);
            session?.server.close().catch(() => {});
          });
        }

        const session = httpSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res, parsedBody);
      } catch (err) {
        logger.error({ err, sessionId }, "Error handling Streamable HTTP request");
        if (!res.headersSent) {
          json(res, 500, { error: "Failed to handle HTTP request" });
        }
      }
    };
    logger.info("Streamable HTTP transport configured at /mcp");
  } else if (transportConfig.type === "sse") {
    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
    const sseConnections = new Map<string, { transport: InstanceType<typeof SSEServerTransport>; server: Awaited<ReturnType<typeof createMcpServer>> }>();

    mcpHandler = async (req, res) => {
      const url = req.url?.split("?")[0] ?? "";

      if (req.method === "GET" && url === "/mcp/sse") {
        try {
          const server = await createMcpServer(deps.skillService, deps.skillProvider, deps.serverName, deps.serverVersion, contextBuilder);
          const transport = new SSEServerTransport("/mcp/messages", res);
          // Use transport's own sessionId — it embeds this in the endpoint event sent to the client,
          // so POST requests will arrive with this exact ID.
          const sessionId = transport.sessionId;
          sseConnections.set(sessionId, { transport, server });

          await server.connect(transport);

          // Cleanup when connection closes
          const cleanup = () => {
            sseConnections.delete(sessionId);
            server.close().catch((err) => logger.debug({ err }, "Error closing SSE server"));
          };
          req.on("close", cleanup);
          res.on("close", cleanup);
          res.on("finish", cleanup);
        } catch (err) {
          logger.error({ err }, "Failed to create SSE connection");
          json(res, 500, { error: "Failed to create SSE connection" });
        }
        return;
      }

      if (req.method === "POST" && url === "/mcp/messages") {
        const { URL: URLParser } = await import("node:url");
        const urlObj = new URLParser(req.url ?? "/", `http://${req.headers.host}`);
        const sessionId = urlObj.searchParams.get("sessionId");

        if (sessionId && sseConnections.has(sessionId)) {
          try {
            await sseConnections.get(sessionId)!.transport.handlePostMessage(req, res);
            return;
          } catch (err) {
            logger.error({ err, sessionId }, "Error handling SSE message");
            sseConnections.delete(sessionId);
            json(res, 500, { error: "Failed to handle SSE message" });
            return;
          }
        }

        // Fallback: use first available session if sessionId not provided
        if (!sessionId && sseConnections.size === 1) {
          try {
            const conn = sseConnections.values().next().value;
            if (conn) {
              await conn.transport.handlePostMessage(req, res);
              return;
            }
          } catch (err) {
            logger.error({ err }, "Error handling SSE message (fallback)");
          }
        }

        json(res, 400, { error: "No active SSE session" });
        return;
      }
    };
    logger.info("SSE transport configured at /mcp/sse");
  }

  // Register API routes
  const adminRouter = new Router();
  const gatewayRouter = new Router();
  registerAdminSkillRoutes(adminRouter, deps);
  registerAdminUserRoutes(adminRouter, deps);
  registerAdminRoleRoutes(adminRouter, deps);
  registerGatewaySkillRoutes(gatewayRouter, deps);

  // Request handler
  httpServer.on("request", async (req, res) => {
    const startTime = Date.now();
    const requestId = attachRequestId(req, res);

    try {
      const url = req.url?.split("?")[0] ?? "";

      if (url === "/mcp" || url === "/mcp/sse" || url === "/mcp/messages") {
        if (mcpHandler) { await mcpHandler(req, res); return; }
        if (isCloudServiceOnlyMode) { json(res, 403, { error: "MCP not available in cloud mode" }); return; }
      }

      if (appConfig.transport.mcpOnlyMode) { json(res, 404, { error: "Not found (MCP-only mode)" }); return; }

      // Metrics endpoint
      if (url === "/metrics") {
        const metricsData = await registry.metrics();
        res.writeHead(200, { "Content-Type": registry.contentType });
        res.end(metricsData);
        return;
      }

      // Legacy health
      if (url === "/api/health") { json(res, 200, { status: "ok", timestamp: new Date().toISOString() }); return; }

      // Gateway routes (per-user RBAC enforced inside handlers via TagPermissionFilter +
      // skill.visibility — anonymous requests can only see public skills)
      if (url.startsWith("/api/gateway/")) {
        const match = gatewayRouter.match(req.method!, url);
        if (match) {
          const ctx: HttpContext = { req, res, url, method: req.method!, params: match.params, query: parseQuery(req.url ?? "/", req.headers.host), logger };
          await match.handler(ctx);
          recordMetrics(url, req.method!, res.statusCode, startTime);
          return;
        }
      }

      // Admin routes
      if (url.startsWith("/api/admin/")) {
        const match = adminRouter.match(req.method!, url);
        if (match) {
          const ctx: HttpContext = { req, res, url, method: req.method!, params: match.params, query: parseQuery(req.url ?? "/", req.headers.host), logger };
          await match.handler(ctx);
          recordMetrics(url, req.method!, res.statusCode, startTime);
          return;
        }
      }

      json(res, 404, { error: "Not found" });
      recordMetrics(url, req.method!, 404, startTime);
    } catch (err) {
      logger.error({ err, url: req.url, requestId }, "Request handler error");
      if (!res.headersSent) { json(res, 500, { error: "Internal server error" }); }
      recordMetrics(req.url?.split("?")[0] ?? "/", req.method!, 500, startTime);
    }
  });

  function recordMetrics(route: string, method: string, statusCode: number, startTime: number) {
    const duration = (Date.now() - startTime) / 1000;
    metrics.httpRequests.inc({ route, method, status_code: statusCode });
    metrics.httpDuration.observe({ route }, duration);
  }

  return httpServer;
}
