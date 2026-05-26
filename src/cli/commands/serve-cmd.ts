import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { LocalFileSystemProvider } from "../../storage/local-fs.provider.js";
import type { IStorageProvider } from "../../storage/provider.interface.js";
import { CompositeCacheProvider } from "../../cache/composite.provider.js";
import { LocalSkillProvider } from "../../provider/local.provider.js";
import { RemoteSkillProvider } from "../../provider/remote.provider.js";
import { instrumentProvider } from "../../provider/instrument.js";
import { createContextBuilder, withFallbackToken } from "../../permission/context-builder.js";
import { assertStdioTokenOrExit } from "./serve-stdio-auth.js";
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
import { PipelineRunRepository } from "../../db/repositories/pipeline-run.repository.js";
import { PipelineRunStore } from "../../pipeline/run-store.js";
import { SkillImporter } from "../../import/importer.js";
import { DomainEventBus } from "../../events/event-bus.js";
import { CacheEpochManager } from "../../cache/cache-epochs.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger();

export interface ServeOptions {
  transport: "stdio" | "sse" | "http";
  port: number;
  host: string;
  mode: "standalone" | "gateway" | "cloud";
  authToken?: string;
}

export async function serveAction(options: ServeOptions): Promise<void> {
  const config = getConfig();

  // Validate deployment mode with transport
  if (options.mode === "cloud" && options.transport === "stdio") {
    logger.error("cloud mode cannot use stdio transport (MCP not available). Use --transport sse or --transport http");
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
  const pipelineRunRepo = new PipelineRunRepository(db);
  const pipelineRunStore = new PipelineRunStore(pipelineRunRepo);

  // Initialize cache
  const cache = new CompositeCacheProvider({
    memory: config.cache.memory,
    file: config.cache.file,
  });

  // Initialize storage
  let storage: IStorageProvider;
  const storageType = config.storage.type;
  if (storageType === "local-fs") {
    storage = new LocalFileSystemProvider(config.storage.basePath);
  } else if (storageType === "aliyun-oss") {
    const { AliyunOssProvider } = await import("../../storage/aliyun-oss.provider.js");
    storage = new AliyunOssProvider({
      bucket: config.storage.bucket,
      region: config.storage.region,
      accessKeyId: config.storage.accessKeyId,
      accessKeySecret: config.storage.accessKeySecret,
    });
  } else {
    throw new Error(`Storage type "${storageType}" not supported`);
  }

  // Initialize provider
  let skillProvider;
  if (options.mode === "gateway" && config.gateway) {
    skillProvider = instrumentProvider(
      new RemoteSkillProvider(
        config.gateway.cloudServiceUrl,
        config.gateway.authToken,
        cache,
      ),
      "remote",
    );
  } else {
    skillProvider = instrumentProvider(
      new LocalSkillProvider(storage, skillRepo, skillFileRepo, cache),
      "local",
    );
  }

  // Initialize services
  const accessLogService = new AccessLogService(accessLogRepo, logger);
  const cacheEpochs = new CacheEpochManager();
  const skillService = new SkillService(
    skillProvider,
    cache,
    logger,
    accessLogService,
    feedbackRepo,
    versionRepo,
    skillRepo,
    storage,
    cacheEpochs,
    skillFileRepo,
  );
  const contextBuilder = createContextBuilder(userRepo, userRoleRepo);

  // Initialize event bus and importer
  const eventBus = new DomainEventBus();
  const importer = new SkillImporter(storage, skillRepo, skillFileRepo, cache, logger, eventBus, versionRepo);

  // Start based on transport
  let stdioMcpServer: Awaited<ReturnType<typeof createMcpServer>> | null = null;
  let httpServer: Awaited<ReturnType<typeof createApp>> | null = null;

  if (options.transport === "stdio") {
    // stdio: single connection, single McpServer.
    // stdio has no per-request auth header, so we resolve a token at startup
    // (CLI flag overrides env) and inject it into every contextBuilder call.
    const stdioToken = options.authToken ?? config.auth?.stdioToken;
    await assertStdioTokenOrExit(stdioToken, { userRepo, skillRepo, logger });
    const stdioContextBuilder = withFallbackToken(contextBuilder, stdioToken);
    stdioMcpServer = await createMcpServer(skillService, skillProvider, config.app.name, config.app.version, stdioContextBuilder, pipelineRunStore);
    const { transport } = createTransport({ type: "stdio" });
    await stdioMcpServer.connect(transport);
  } else {
    // SSE or Streamable HTTP: handled by raw Node.js HTTP server
    httpServer = await createApp(
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
        cacheEpochs,
        userRepo,
        roleRepo,
        userRoleRepo,
        feedbackRepo,
        pipelineRunStore,
      },
      { type: options.transport as "sse" | "http" },
    );
    await new Promise<void>((resolve) => {
      httpServer!.listen(options.port, options.host, () => resolve());
    });

    logger.info(
      { transport: options.transport, port: options.port, host: options.host, mode: options.mode },
      "MCP Server started",
    );
  }

  // Graceful shutdown: stop accepting work, drain in-flight requests, then close DB.
  // 5s timeout fallback so a stuck connection can't keep the process alive forever.
  const SHUTDOWN_TIMEOUT_MS = 5000;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down...");

    const timer = setTimeout(() => {
      logger.warn({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "Shutdown timeout exceeded, forcing exit");
      try { closeDatabase(); } catch { /* ignore */ }
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    try {
      if (httpServer) {
        await new Promise<void>((resolve) => {
          httpServer!.close(() => resolve());
        });
      }
      if (stdioMcpServer) {
        await stdioMcpServer.close().catch(err => logger.debug({ err }, "mcpServer.close failed"));
      }
    } catch (err) {
      logger.warn({ err }, "Error during graceful shutdown");
    } finally {
      clearTimeout(timer);
      try { closeDatabase(); } catch (err) { logger.debug({ err }, "closeDatabase failed"); }
      process.exit(0);
    }
  };
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
}
