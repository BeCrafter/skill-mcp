import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { LocalFileSystemProvider } from "../../storage/local-fs.provider.js";
import { CompositeCacheProvider } from "../../cache/composite.provider.js";
import { LocalSkillProvider } from "../../provider/local.provider.js";
import { RemoteSkillProvider } from "../../provider/remote.provider.js";
import type { ISkillProvider } from "../../provider/interface.js";
import { instrumentProvider } from "../../provider/instrument.js";
import { createContextBuilder, withFallbackToken } from "../../permission/context-builder.js";
import { assertStdioTokenOrExit } from "./serve-stdio-auth.js";
import { SkillService } from "../../services/skill.service.js";
import { SkillSearchService } from "../../services/skill-search.service.js";
import { AccessLogService } from "../../services/access-log.service.js";
import { createMcpServer } from "../../mcp/server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
import { CacheEpochManager } from "../../cache/cache-epochs.js";
import { CacheEpochRepository } from "../../db/repositories/cache-epoch.repository.js";
import { AuditLogRepository } from "../../db/repositories/audit-log.repository.js";
import { getConfig, ensureDirectories } from "../../config/index.js";
import { getLogger } from "../../utils/logger.js";
import { c, banner, kv, section, kvWidth, fail } from "../ui.js";

const logger = getLogger();

export interface ServeOptions {
  transport: "stdio" | "sse" | "http";
  port: number;
  mcpOnly: boolean;
  apiOnly: boolean;
  authToken?: string;
}

export function validateServerProfile(options: ServeOptions): void {
  if (options.mcpOnly && options.apiOnly) {
    fail("--mcp-only and --api-only are mutually exclusive");
    process.exit(1);
  }
  if (options.apiOnly && options.transport === "stdio") {
    fail("--api-only cannot be used with stdio transport", "Use --transport sse or --transport http for API-only mode");
    process.exit(1);
  }
}

export async function serveAction(options: ServeOptions): Promise<void> {
  const config = getConfig();
  validateServerProfile(options);
  ensureDirectories(config);
  logger.info({ mcpOnly: options.mcpOnly, apiOnly: options.apiOnly, transport: options.transport, port: options.port }, "Starting local Skill MCP Registry");

  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  const skillRepo = new SkillRepository(db);
  const skillFileRepo = new SkillFileRepository(db);
  const accessLogRepo = new AccessLogRepository(db);
  const userRepo = new UserRepository(db);
  const roleRepo = new RoleRepository(db);
  const userRoleRepo = new UserRoleRepository(db);
  const feedbackRepo = new SkillFeedbackRepository(db);
  const versionRepo = new SkillVersionRepository(db);
  const auditRepo = new AuditLogRepository(db);

  const cache = new CompositeCacheProvider({ memory: config.cache.memory, file: config.cache.file });
  const storage = new LocalFileSystemProvider(config.storage.basePath);
  const cacheEpochs = new CacheEpochManager(new CacheEpochRepository(db));
  cacheEpochs.hydrate();

  const accessLogService = new AccessLogService(accessLogRepo, logger);
  const eventBus = new DomainEventBus();
  const skillSearchService = new SkillSearchService(skillRepo, logger);

  // C2 remote-proxy mode: when CLOUD_SERVICE_URL is set, front a remote
  // storage Registry via RemoteSkillProvider and proxy skill_search to it
  // (storage handles RBAC + BM25 via its local index). Local SQLite + fs
  // are still wired for user/auth/feedback/audit parity with HEAD semantics.
  const remoteUrl = config.gateway?.cloudServiceUrl;
  const remoteToken = options.authToken ?? config.auth?.stdioToken ?? "";

  let skillProvider: ISkillProvider;
  let remoteSearch: NonNullable<SkillService["remoteSearch"]> | undefined;
  if (remoteUrl) {
    skillSearchService.subscribe(eventBus);
    const remote = new RemoteSkillProvider(remoteUrl, remoteToken, cache);
    skillProvider = instrumentProvider(remote, "remote");
    remoteSearch = (q, opt) => remote.search(q, { limit: opt.limit, tags: opt.tags });
    logger.info({ proxy: remoteUrl, mcpOnly: options.mcpOnly }, "C2 proxy mode — fronting remote storage Registry");
  } else {
    skillSearchService.subscribe(eventBus);
    skillProvider = instrumentProvider(new LocalSkillProvider(storage, skillRepo, skillFileRepo, cache), "local");
    remoteSearch = undefined;
    await skillSearchService.init();
    logger.info({ mcpOnly: options.mcpOnly, apiOnly: options.apiOnly, transport: options.transport, port: options.port }, "Starting local Skill MCP Registry");
  }

  const importer = new SkillImporter(
    storage,
    skillRepo,
    skillFileRepo,
    cache,
    logger,
    eventBus,
    versionRepo,
    config.security.enableInjectionScan,
    async (slug) => skillSearchService.refreshOne(slug),
  );
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
    { eventBus, importer, accessLogRepo, auditRepo, searchService: skillSearchService, remoteSearch },
  );

  const contextBuilder = createContextBuilder(userRepo, userRoleRepo, config.auth?.jwt?.secret, config.auth?.jwt?.issuer);

  const out = options.transport === "stdio" ? process.stderr : process.stdout;
  out.write(banner(config.app.name, config.app.version) + "\n\n");
  let stdioMcpServer: Awaited<ReturnType<typeof createMcpServer>> | null = null;
  let httpServer: Awaited<ReturnType<typeof createApp>> | null = null;

  if (options.transport === "stdio") {
    const stdioToken = options.authToken ?? config.auth?.stdioToken;
    await assertStdioTokenOrExit(stdioToken, { userRepo, skillRepo, logger });
    stdioMcpServer = await createMcpServer(skillService, skillProvider, config.app.name, config.app.version, withFallbackToken(contextBuilder, stdioToken));
    await stdioMcpServer.connect(new StdioServerTransport());
  } else {
    httpServer = await createApp({
      skillService, skillProvider, serverName: config.app.name, serverVersion: config.app.version,
      skillRepo, skillFileRepo, accessLogRepo, storage, cache, importer, eventBus, cacheEpochs,
      userRepo, roleRepo, userRoleRepo, feedbackRepo,
      jwtSecret: config.auth?.jwt?.secret, jwtIssuer: config.auth?.jwt?.issuer,
      jwtAccessExpiresIn: config.auth?.jwt?.accessExpiresIn, jwtRefreshExpiresIn: config.auth?.jwt?.refreshExpiresIn,
      mcpOnly: options.mcpOnly, apiOnly: options.apiOnly,
    }, { type: options.transport });
    await new Promise<void>((resolve) => httpServer!.listen(options.port, "0.0.0.0", resolve));
    const labels: [string, string][] = [
      ["registry", "local SQLite + local-fs"], ["mcp-only", String(options.mcpOnly)],
      ["api-only", String(options.apiOnly)], ["transport", options.transport], ["port", String(options.port)],
    ];
    const maxLen = kvWidth(0, ...labels.map(([key]) => key));
    console.log(`\n${section("listening", undefined, 60)}`);
    for (const [key, value] of labels) console.log(kv(key, value, maxLen));
    console.log(`\n  ${c.boldGreen("✓")}  ${c.bold("Ready")}\n`);
    logger.info({ transport: options.transport, port: options.port, mcpOnly: options.mcpOnly, apiOnly: options.apiOnly }, "MCP Server started");
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    if (stdioMcpServer) await stdioMcpServer.close().catch((err) => logger.debug({ err }, "MCP server close failed"));
    closeDatabase();
    process.exit(0);
  };
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
}
