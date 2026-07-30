import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { getLogger } from "./utils/logger.js";
import { getConfig } from "./config/index.js";
import { createContextBuilder } from "./permission/context-builder.js";
import { Router } from "./http/router.js";
import { registerAdminSkillRoutes } from "./http/handlers/admin/skills.handler.js";
import { registerAdminUserRoutes } from "./http/handlers/admin/users.handler.js";
import { registerAdminRoleRoutes } from "./http/handlers/admin/roles.handler.js";
import { registerAuthRoutes } from "./http/handlers/auth.handler.js";
import { registerGatewaySkillRoutes } from "./http/handlers/gateway/skills.handler.js";
import { errorMap } from "./http/middleware/error-map.js";
import { createRateLimit } from "./http/middleware/rate-limit.js";
import { createRequestHandler } from "./http/server.js";
import { createHttpMcpHandler } from "./mcp/transport/http-transport.js";
import { createSseMcpHandler } from "./mcp/transport/sse-transport.js";
import { setupCacheSubscribers } from "./events/cache-subscriber.js";
import type { AppDependencies, TransportConfig } from "./app-dependencies.js";

export type { AppDependencies, TransportConfig } from "./app-dependencies.js";
const logger = getLogger();

export async function createApp(deps: AppDependencies, transportConfig: TransportConfig): Promise<Server> {
  const httpServer = createServer();
  const appConfig = getConfig();
  setupCacheSubscribers(deps.eventBus, deps.cache, deps.cacheEpochs, { roleRepo: deps.roleRepo, userRoleRepo: deps.userRoleRepo });

  const mcpOnly = deps.mcpOnly ?? appConfig.deployment.mcpOnly;
  const apiOnly = deps.apiOnly ?? appConfig.deployment.apiOnly;
  const contextBuilder = deps.userRepo && deps.userRoleRepo
    ? createContextBuilder(deps.userRepo, deps.userRoleRepo, deps.jwtSecret, deps.jwtIssuer)
    : undefined;

  let mcpHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
  if (!apiOnly) {
    if (transportConfig.type === "http") {
      mcpHandler = await createHttpMcpHandler(deps, contextBuilder);
      logger.info("Streamable HTTP transport configured at /mcp");
    } else {
      mcpHandler = await createSseMcpHandler(deps, contextBuilder);
      logger.info("SSE transport configured at /mcp/sse");
    }
  }

  const authRouter = new Router();
  authRouter.use(errorMap("Auth operation failed"));
  registerAuthRoutes(authRouter, deps);

  let adminRouter: Router | undefined;
  if (!mcpOnly) {
    adminRouter = new Router();
    adminRouter.use(errorMap("Admin operation failed"));
    if (appConfig.rateLimit.enabled) adminRouter.use(createRateLimit({
      capacity: appConfig.rateLimit.adminCapacity, refillPerSec: appConfig.rateLimit.adminRefillPerSec, scope: "admin",
    }));
    registerAdminSkillRoutes(adminRouter, deps);
    registerAdminUserRoutes(adminRouter, deps);
    registerAdminRoleRoutes(adminRouter, deps);
  }

  let gatewayRouter: Router | undefined;
  if (!mcpOnly) {
    gatewayRouter = new Router();
    gatewayRouter.use(errorMap("Gateway operation failed"));
    if (appConfig.rateLimit.enabled) gatewayRouter.use(createRateLimit({
      capacity: appConfig.rateLimit.gatewayCapacity, refillPerSec: appConfig.rateLimit.gatewayRefillPerSec, scope: "gateway",
    }));
    registerGatewaySkillRoutes(gatewayRouter, deps);
  }

  httpServer.on("request", createRequestHandler({
    appConfig, mcpHandler, mcpOnly, adminRouter, gatewayRouter,
    userRepo: deps.userRepo, userRoleRepo: deps.userRoleRepo, skillRepo: deps.skillRepo,
    jwtSecret: deps.jwtSecret, jwtIssuer: deps.jwtIssuer, authRouter,
  }));
  return httpServer;
}
