import { z } from "zod";

export const storageConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("local-fs"),
    basePath: z.string().default("./data/skills"),
  }),
  z.object({
    type: z.literal("aliyun-oss"),
    bucket: z.string(),
    region: z.string(),
    accessKeyId: z.string().optional(),
    accessKeySecret: z.string().optional(),
  }),
]).default({ type: "local-fs", basePath: "./data/skills" });

export const gatewayConfigSchema = z.object({
  cloudServiceUrl: z.string().url(),
  authToken: z.string(),
}).optional();

export const cacheConfigSchema = z.object({
  memory: z.object({
    enabled: z.boolean().default(true),
    maxSize: z.number().default(500),
  }).default({ enabled: true, maxSize: 500 }),
  file: z.object({
    enabled: z.boolean().default(true),
    cacheDir: z.string().default("./data/cache"),
  }).default({ enabled: true, cacheDir: "./data/cache" }),
}).default({});

export const configSchema = z.object({
  app: z.object({
    name: z.string().default("skill-mcp"),
    version: z.string().default("0.0.1"),
    env: z.enum(["development", "production", "test"]).default("development"),
  }),

  deployment: z.object({
    mode: z.enum(["standalone", "gateway", "cloud"]).default("standalone"),
  }),

  gateway: gatewayConfigSchema,

  storage: storageConfigSchema,

  database: z.object({
    path: z.string(),
  }),

  cache: cacheConfigSchema,

  transport: z.object({
    type: z.enum(["stdio", "sse", "http"]).default("stdio"),
    port: z.number().default(3000),
    host: z.string().default("0.0.0.0"),
    mcpOnlyMode: z.boolean().default(false),
  }).default({
    type: "stdio",
    port: 3000,
    host: "0.0.0.0",
    mcpOnlyMode: false,
  }),

  security: z.object({
    enableInjectionScan: z.boolean().default(true),
    /**
     * T-737 — Whether to emit `Strict-Transport-Security` on every response.
     *
     * HSTS is a browser instruction to refuse plain `http://` for the host.
     * Sending it from a server that is *not* behind a TLS terminator pins the
     * browser to HTTPS for `max-age` seconds, breaking access for any caller
     * that reaches the server over plain HTTP (the common dev / intra-cluster
     * setup). Default `false` — opt in only when there is a TLS terminator
     * in front (nginx / ALB / CDN). The reverse proxy can still inject HSTS
     * itself even with this off (see nginx.conf).
     */
    hstsEnabled: z.boolean().default(false),
  }).default({
    enableInjectionScan: true,
    hstsEnabled: false,
  }),

  auth: z.object({
    stdioToken: z.string().optional(),
    /**
     * Backwards-compat escape hatch for `/api/admin/*` routes.
     *   true  → admin endpoints are anonymous (PRE-T-004 behavior)
     *   false → admin endpoints require a token whose role tags include `admin:write`
     * Default false (secure-by-default). Existing deployments that relied on
     * network isolation must opt in explicitly via SKILL_MCP_ADMIN_AUTH_OPTIONAL=true,
     * which is logged as a warning at startup and tracked for removal.
     */
    adminAuthOptional: z.boolean().default(false),
    /**
     * T-707 — `/metrics` Prometheus exposition was anonymous, leaking route
     * names, session counts, and cache hit rates to any caller. Default now
     * gates it behind admin tag auth (same as `/api/admin/*`). Set this to
     * true to restore the legacy anonymous behavior for trusted intra-cluster
     * scrapers; logged at startup like adminAuthOptional.
     */
    metricsAuthOptional: z.boolean().default(false),
  }).default({}),
});

export type AppConfig = z.infer<typeof configSchema>;
