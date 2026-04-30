import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { LocalFileSystemProvider } from "../../storage/local-fs.provider.js";
import { CompositeCacheProvider } from "../../cache/composite.provider.js";
import { LocalSkillProvider } from "../../provider/local.provider.js";
import { RemoteSkillProvider } from "../../provider/remote.provider.js";
import { NoopPermissionFilter } from "../../permission/noop-filter.js";
import { createContextBuilder } from "../../permission/context-builder.js";
import { SkillService } from "../../services/skill.service.js";
import { AccessLogService } from "../../services/access-log.service.js";
import { createMcpServer } from "../../mcp/server.js";
import { createTransport } from "../../mcp/transport/index.js";
import { createApp } from "../../app.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { SkillFileRepository } from "../../db/repositories/skill-file.repository.js";
import { AccessLogRepository } from "../../db/repositories/access-log.repository.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { RoleRepository } from "../../db/repositories/role.repository.js";
import { UserRoleRepository } from "../../db/repositories/user-role.repository.js";
import { SkillFeedbackRepository } from "../../db/repositories/skill-feedback.repository.js";
import { SkillVersionRepository } from "../../db/repositories/skill-version.repository.js";
import { SkillImporter } from "../../import/importer.js";
import { DomainEventBus } from "../../events/event-bus.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger();

export interface ServeOptions {
  transport: "stdio" | "sse" | "http";
  port: number;
  host: string;
  mode: "standalone" | "gateway" | "cloud-service-only";
}

export async function serveAction(options: ServeOptions): Promise<void> {
  const config = getConfig();

  // Validate deployment mode with transport
  if (options.mode === "cloud-service-only" && options.transport === "stdio") {
    logger.error("cloud-service-only mode cannot use stdio transport (MCP not available). Use --transport sse or --transport http");
    process.exit(1);
  }

  logger.info(
    { deploymentMode: options.mode, transport: options.transport, port: options.port, host: options.host },
    `Starting MCP Server in ${options.mode} mode`,
  );

  // Run migrations
  runMigrations(config.database.path);

  // Initialize database
  const db = getDatabase(config.database.path);
  const skillRepo = new SkillRepository(db);
  const skillFileRepo = new SkillFileRepository(db);
  const accessLogRepo = new AccessLogRepository(db);
  const userRepo = new UserRepository(db);
  const roleRepo = new RoleRepository(db);
  const userRoleRepo = new UserRoleRepository(db);
  const feedbackRepo = new SkillFeedbackRepository(db);
  const versionRepo = new SkillVersionRepository(db);

  // Initialize cache
  const cache = new CompositeCacheProvider({
    memory: config.cache.memory,
    file: config.cache.file,
  });

  // Initialize storage
  let storage: LocalFileSystemProvider;
  if (config.storage.type === "local-fs") {
    storage = new LocalFileSystemProvider(config.storage.basePath);
  } else {
    throw new Error(`Storage type "${config.storage.type}" not implemented in MVP`);
  }

  // Initialize provider
  let skillProvider;
  if (options.mode === "gateway" && config.gateway) {
    skillProvider = new RemoteSkillProvider(
      config.gateway.cloudServiceUrl,
      config.gateway.authToken,
      cache,
    );
  } else {
    skillProvider = new LocalSkillProvider(storage, skillRepo, skillFileRepo, cache);
  }

  // Initialize services
  const permissionFilter = new NoopPermissionFilter();
  const accessLogService = new AccessLogService(accessLogRepo, logger);
  const skillService = new SkillService(
    skillProvider,
    cache,
    permissionFilter,
    logger,
    accessLogService,
    feedbackRepo,
    versionRepo,
    skillRepo,
    storage,
  );
  const contextBuilder = createContextBuilder(userRepo, userRoleRepo);

  // Initialize event bus and importer
  const eventBus = new DomainEventBus();
  const importer = new SkillImporter(storage, skillRepo, skillFileRepo, cache, logger, eventBus, versionRepo);

  // Start based on transport
  if (options.transport === "stdio") {
    // stdio: single connection, single McpServer
    const mcpServer = await createMcpServer(skillService, skillProvider, config.app.name, config.app.version, contextBuilder);
    const { transport } = createTransport({ type: "stdio", server: mcpServer });
    await mcpServer.connect(transport);
  } else {
    // SSE or Streamable HTTP: handled by raw Node.js HTTP server
    const httpServer = await createApp(
      {
        skillService,
        skillProvider,
        serverName: config.app.name,
        serverVersion: config.app.version,
        skillRepo,
        skillFileRepo,
        accessLogRepo,
        storage,
        cache,
        importer,
        eventBus,
        userRepo,
        roleRepo,
        userRoleRepo,
        feedbackRepo,
      },
      { type: options.transport as "sse" | "http" },
    );
    await new Promise<void>((resolve) => {
      httpServer.listen(options.port, options.host, () => resolve());
    });

    logger.info(
      { transport: options.transport, port: options.port, host: options.host, mode: options.mode },
      "MCP Server started",
    );
  }

  // Graceful shutdown
  const shutdown = async (_signal: string) => {
    logger.info("Shutting down...");
    closeDatabase();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
