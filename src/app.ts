import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createMcpServer } from "./mcp/server.js";
import { getLogger } from "./utils/logger.js";
import { getConfig } from "./config/index.js";
import { createApiKeyAuthMiddleware } from "./middleware/apikey-auth.js";
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
  const isCloudServiceOnlyMode = appConfig.deployment.mode === "cloud-service-only";
  const contextBuilder = deps.userRepo && deps.userRoleRepo
    ? createContextBuilder(deps.userRepo, deps.userRoleRepo)
    : undefined;

  if (isCloudServiceOnlyMode) {
    logger.info("Cloud Service only mode: MCP transport disabled");
  } else if (transportConfig.type === "http") {
    const mcpServer = await createMcpServer(deps.skillService, deps.skillProvider, deps.serverName, deps.serverVersion, contextBuilder);
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    await mcpServer.connect(transport);
    mcpHandler = async (req, res) => { await transport.handleRequest(req, res); };
    logger.info("Streamable HTTP transport configured at /mcp");
  } else if (transportConfig.type === "sse") {
    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
    const sseTransports = new Map<string, InstanceType<typeof SSEServerTransport>>();
    mcpHandler = async (req, res) => {
      const url = req.url?.split("?")[0] ?? "";
      if (req.method === "GET" && url === "/mcp/sse") {
        const sessionId = crypto.randomUUID();
        const server = await createMcpServer(deps.skillService, deps.skillProvider, deps.serverName, deps.serverVersion, contextBuilder);
        const transport = new SSEServerTransport("/mcp/messages", res);
        sseTransports.set(sessionId, transport);
        await server.connect(transport);
        req.on("close", () => { sseTransports.delete(sessionId); server.close().catch(() => {}); });
        return;
      }
      if (req.method === "POST" && url === "/mcp/messages") {
        const { URL: URLParser } = await import("node:url");
        const urlObj = new URLParser(req.url ?? "/", `http://${req.headers.host}`);
        const sessionId = urlObj.searchParams.get("sessionId");
        if (sessionId && sseTransports.has(sessionId)) { await sseTransports.get(sessionId)!.handlePostMessage(req, res); return; }
        if (sseTransports.size === 1) { await sseTransports.values().next().value!.handlePostMessage(req, res); return; }
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

  const apiKeyAuth = createApiKeyAuthMiddleware(appConfig.apiKey ?? { enabled: false, keys: [] });

  // Request handler
  httpServer.on("request", async (req, res) => {
    const startTime = Date.now();
    const requestId = attachRequestId(req, res);

    try {
      const url = req.url?.split("?")[0] ?? "";

      if (url === "/mcp" || url === "/mcp/sse" || url === "/mcp/messages") {
        if (mcpHandler) { await mcpHandler(req, res); return; }
        if (isCloudServiceOnlyMode) { json(res, 403, { error: "MCP not available in cloud-service-only mode" }); return; }
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

      // Gateway routes (auth required)
      if (url.startsWith("/api/gateway/")) {
        const authed = await apiKeyAuth(req, res);
        if (!authed) {
          recordMetrics(url, req.method!, res.statusCode, startTime);
          return;
        }
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
