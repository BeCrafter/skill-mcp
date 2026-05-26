import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { getLogger } from "./utils/logger.js";
import { getConfig } from "./config/index.js";
import { createContextBuilder } from "./permission/context-builder.js";
import { Router } from "./http/router.js";
import { registerAdminSkillRoutes } from "./http/handlers/admin/skills.handler.js";
import { registerAdminUserRoutes } from "./http/handlers/admin/users.handler.js";
import { registerAdminRoleRoutes } from "./http/handlers/admin/roles.handler.js";
import { registerGatewaySkillRoutes } from "./http/handlers/gateway/skills.handler.js";
import { errorMap } from "./http/middleware/error-map.js";
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

  // Per-user epoch counters keep cache invalidation O(1): a private+tagged
  // skill change only bumps epochs of users whose roles intersect those tags.
  setupCacheSubscribers(deps.eventBus, deps.cache, deps.cacheEpochs, {
    roleRepo: deps.roleRepo,
    userRoleRepo: deps.userRoleRepo,
  });

  if (appConfig.auth.adminAuthOptional) {
    logger.warn(
      "SKILL_MCP_ADMIN_AUTH_OPTIONAL=true — /api/admin/* is anonymous. " +
        "Legacy escape hatch; gate admin endpoints with a token bearing the 'admin:write' tag.",
    );
  }

  const isCloudServiceOnlyMode = appConfig.deployment.mode === "cloud";
  const contextBuilder = deps.userRepo && deps.userRoleRepo
    ? createContextBuilder(deps.userRepo, deps.userRoleRepo)
    : undefined;

  let mcpHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
  if (isCloudServiceOnlyMode) {
    logger.info("Cloud Service only mode: MCP transport disabled");
  } else if (transportConfig.type === "http") {
    mcpHandler = await createHttpMcpHandler(deps, contextBuilder);
    logger.info("Streamable HTTP transport configured at /mcp");
  } else if (transportConfig.type === "sse") {
    mcpHandler = await createSseMcpHandler(deps, contextBuilder);
    logger.info("SSE transport configured at /mcp/sse");
  }

  const adminRouter = new Router();
  adminRouter.use(errorMap("Admin operation failed"));
  registerAdminSkillRoutes(adminRouter, deps);
  registerAdminUserRoutes(adminRouter, deps);
  registerAdminRoleRoutes(adminRouter, deps);

  const gatewayRouter = new Router();
  gatewayRouter.use(errorMap("Gateway operation failed"));
  registerGatewaySkillRoutes(gatewayRouter, deps);

  httpServer.on("request", createRequestHandler({
    appConfig, mcpHandler, isCloudServiceOnlyMode,
    adminRouter, gatewayRouter,
    userRepo: deps.userRepo, userRoleRepo: deps.userRoleRepo,
  }));

  return httpServer;
}
