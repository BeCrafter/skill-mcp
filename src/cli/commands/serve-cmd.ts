import { getConfig, ensureDirectories } from "../../config/index.js";
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
import { SkillEmbeddingRepository } from "../../db/repositories/skill-embedding.repository.js";
import { SkillEvalRepository } from "../../db/repositories/skill-eval.repository.js";
import { PipelineRunRepository } from "../../db/repositories/pipeline-run.repository.js";
import { PipelineRunStore } from "../../pipeline/run-store.js";
import { SkillImporter } from "../../import/importer.js";
import { DomainEventBus } from "../../events/event-bus.js";
import { CacheEpochManager } from "../../cache/cache-epochs.js";
import { CacheEpochRepository } from "../../db/repositories/cache-epoch.repository.js";
import { ImportJobRepository } from "../../db/repositories/import-job.repository.js";
import { AuditLogRepository } from "../../db/repositories/audit-log.repository.js";
import { NullEmbeddingProvider } from "../../retrieval/embedding-provider.js";
import { OpenAIEmbeddingProvider } from "../../retrieval/openai-embedding-provider.js";
import { OllamaEmbeddingProvider } from "../../retrieval/ollama-embedding-provider.js";
import { BackgroundImportWorker } from "../../services/import-worker.js";
import { UsageEventRepository } from "../../db/repositories/usage-event.repository.js";
import { UsageMeterService } from "../../services/usage-meter.service.js";
import { WebhookRepository } from "../../db/repositories/webhook.repository.js";
import { WebhookDeliveryRepository } from "../../db/repositories/webhook-delivery.repository.js";
import { WebhookService } from "../../services/webhook.service.js";
import { WebhookDispatcher } from "../../services/webhook-dispatcher.js";
import { WebhookWorker } from "../../services/webhook-worker.js";
import { getLogger } from "../../utils/logger.js";
import { c, banner, kv, section, kvWidth, fail } from "../ui.js";

const logger = getLogger();

export interface ServeOptions {
  transport: "stdio" | "sse" | "http";
  port: number;
  mcpOnly: boolean;
  apiOnly: boolean;
  remoteUrl?: string;
  authToken?: string;
}

/** Validate serve command argument combinations before any side effects. */
export function validateServerProfile(options: ServeOptions): void {
  if (options.mcpOnly && options.apiOnly) {
    fail("--mcp-only and --api-only are mutually exclusive");
    process.exit(1);
  }
  if (options.apiOnly && options.transport === "stdio") {
    fail("--api-only cannot be used with stdio transport (stdio is MCP-only)", "Use --transport sse or --transport http for API-only mode");
    process.exit(1);
  }
}

export async function serveAction(options: ServeOptions): Promise<void> {
  const config = getConfig();

  validateServerProfile(options);
  ensureDirectories(config);

  // Remote URL: CLI flag > env var
  const remoteUrl = options.remoteUrl ?? config.gateway?.cloudServiceUrl;
  // Remote auth token: --auth-token (CLI) > SKILL_MCP_AUTH_TOKEN (env).
  // stdio mode: serves double duty as both MCP auth and remote proxy credential.
  // sse/http mode: MCP auth comes from per-request Authorization header, this
  // token is only used for remote proxy calls.
  const remoteToken = options.authToken ?? config.auth?.stdioToken ?? "";

  logger.info(
    { proxy: !!remoteUrl, mcpOnly: options.mcpOnly, apiOnly: options.apiOnly, transport: options.transport, port: options.port },
    `Starting MCP Server${remoteUrl ? ` (proxy → ${remoteUrl})` : ""}`,
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
  // P1-12 stage 2 — eval cases + run log. Stays alongside versionRepo because
  // both are import-time write targets and runtime-read targets.
  const evalRepo = new SkillEvalRepository(db);
  const { EchoEvalProvider } = await import("../../eval/echo-provider.js");
  const { EvalRunner } = await import("../../eval/runner.js");
  const evalRunner = new EvalRunner(skillRepo, evalRepo, new EchoEvalProvider(), logger);
  const pipelineRunRepo = new PipelineRunRepository(db);
  const pipelineRunStore = new PipelineRunStore(pipelineRunRepo);
  // P1-13 — usage metering data layer (review §9.1). Constructed unconditionally
  // because every event_type (skill.view, pipeline.run, api.call, storage.write)
  // hangs off this single ledger; admin REST endpoint reuses the same repo.
  const usageEventRepo = new UsageEventRepository(db);
  const usageMeter = new UsageMeterService(usageEventRepo, logger);

  // P1-16 — outbound webhooks (review §5.5.1). The dispatcher polls the
  // delivery queue; producers fan out via DomainEventBus → setupWebhookSubscribers
  // (wired in app.ts). `allowPlaintext` mirrors the dev/prod posture of the
  // rest of the security surface — production only accepts https + non-private.
  const webhookRepo = new WebhookRepository(db);
  const webhookDeliveryRepo = new WebhookDeliveryRepository(db);
  const webhookService = new WebhookService(webhookRepo, webhookDeliveryRepo, logger, {
    allowPlaintext: config.app.env !== "production",
  });
  const webhookDispatcher = new WebhookDispatcher(webhookRepo, webhookDeliveryRepo, webhookService, logger);
  const webhookWorker = new WebhookWorker(webhookDispatcher, logger);

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
  if (remoteUrl) {
    skillProvider = instrumentProvider(
      new RemoteSkillProvider(remoteUrl!, remoteToken, cache),
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
  // P0-B — persist epoch counters across restart so L2 (file) cache keys
  // from the previous run cannot collide with a fresh g0:u0 suffix.
  const cacheEpochRepo = new CacheEpochRepository(db);
  const cacheEpochs = new CacheEpochManager(cacheEpochRepo);
  cacheEpochs.hydrate();
  // Initialize event bus and importer.
  // P0-B — async dispatch decouples the admin write path from cache
  // invalidation latency (see review §3.2). Listener errors still go
  // through the same try/catch isolation as in sync mode.
  const eventBus = new DomainEventBus({ async: true });
  const importer = new SkillImporter(storage, skillRepo, skillFileRepo, cache, logger, eventBus, versionRepo, usageMeter, evalRepo, config.security.enableInjectionScan);
  // P1-11 stages 2b + 3 — in-process BM25 retrieval, plus optional cosine
  // sidecar when an embedding provider is configured. Initialised after
  // the repo is hydrated so the first import / view sees a populated
  // index. Listens on skill:* events for incremental re-index. Soft-fails
  // to substring match if init() races with the first request.
  // The default open-source distribution ships NullEmbeddingProvider, so
  // hybrid search is a no-op until an operator wires in a real provider.
  // Embedding provider — configured via config.embedding
  let embeddingProvider: import("../../retrieval/embedding-provider.js").IEmbeddingProvider = new NullEmbeddingProvider();
  if (config.embedding.provider === "openai" && config.embedding.apiKey) {
    embeddingProvider = new OpenAIEmbeddingProvider({
      apiKey: config.embedding.apiKey,
      model: config.embedding.model,
      baseUrl: config.embedding.baseUrl,
    });
  } else if (config.embedding.provider === "ollama") {
    embeddingProvider = new OllamaEmbeddingProvider({
      model: config.embedding.model,
      baseUrl: config.embedding.baseUrl,
    });
  }

  const skillEmbeddingRepo = new SkillEmbeddingRepository(db);
  const skillSearchService = new SkillSearchService(skillRepo, logger, {
    embeddingProvider,
    embeddingRepo: skillEmbeddingRepo,
  });
  skillSearchService.subscribe(eventBus);
  // P0-A — admin convergence: SkillService owns admin write paths so cache
  // invalidation, event publication, and body allowlisting flow through one
  // place (see review §4.1). Importer / eventBus / accessLogRepo are passed
  // via the trailing options bag to keep existing positional callers working.
  const auditRepo = new AuditLogRepository(db);
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
    { eventBus, importer, accessLogRepo, auditRepo, usageMeter, searchService: skillSearchService, evalRepo },
  );
  // Hydrate the BM25 corpus eagerly so the first MCP/HTTP request hits a
  // ready index. Errors are non-fatal — search() soft-fails to empty result.
  skillSearchService.init().catch((err) => {
    logger.warn({ err }, "Initial BM25 index build failed; will retry on next event");
  });
  const contextBuilder = createContextBuilder(userRepo, userRoleRepo, config.auth?.jwt?.secret, config.auth?.jwt?.issuer);
  // P0-10 — async import job queue + background worker (single-process; the
  // P1 roadmap promotes this to an external Redis/PG queue, see review §11).
  const importJobRepo = new ImportJobRepository(db);
  const importWorker = new BackgroundImportWorker(importJobRepo, importer, logger);
  importWorker.start();
  webhookWorker.start();
  // ── Startup banner ────────────────────────────────────────────────
  // In stdio mode, stdout is reserved for MCP JSON-RPC messages.
  // Output the banner to stderr so it doesn't corrupt the protocol stream.
  const out = options.transport === "stdio" ? process.stderr : process.stdout;
  out.write(banner(config.app.name, config.app.version) + "\n\n");

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
    stdioMcpServer = await createMcpServer(skillService, skillProvider, config.app.name, config.app.version, stdioContextBuilder, pipelineRunStore, usageMeter);
    const transport = new StdioServerTransport();
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
        importJobRepo,
        importWorker,
        usageEventRepo,
        usageMeter,
        webhookRepo,
        webhookDeliveryRepo,
        webhookService,
        webhookWorker,
        evalRepo,
        evalRunner,
        jwtSecret: config.auth?.jwt?.secret,
        jwtIssuer: config.auth?.jwt?.issuer,
        jwtAccessExpiresIn: config.auth?.jwt?.accessExpiresIn,
        jwtRefreshExpiresIn: config.auth?.jwt?.refreshExpiresIn,
        mcpOnly: options.mcpOnly,
        apiOnly: options.apiOnly,
      },
      { type: options.transport as "sse" | "http" },
    );
    await new Promise<void>((resolve) => {
      httpServer!.listen(options.port, "0.0.0.0", () => resolve());
    });

    // Show startup summary to operator
    const labels: [string, string][] = [
      ["proxy", remoteUrl ? remoteUrl : "(local)"],
      ["mcp-only", String(options.mcpOnly)],
      ["api-only", String(options.apiOnly)],
      ["transport", options.transport],
      ["port", String(options.port)],
    ];
    const maxLen = kvWidth(0, ...labels.map(([k]) => k));
    console.log();
    console.log(section("listening", undefined, 60));
    for (const [k, v] of labels) {
      console.log(kv(k, v, maxLen));
    }
    console.log();
    console.log(`  ${c.boldGreen("✓")}  ${c.bold("Ready")}`);
    console.log();

    logger.info(
      { transport: options.transport, port: options.port, proxy: !!remoteUrl, mcpOnly: options.mcpOnly, apiOnly: options.apiOnly },
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
      // Stop the import worker first so no new jobs start mid-shutdown.
      await importWorker.stop().catch(err => logger.debug({ err }, "importWorker.stop failed"));
      await webhookWorker.stop().catch(err => logger.debug({ err }, "webhookWorker.stop failed"));
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
