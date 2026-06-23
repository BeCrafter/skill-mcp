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

  rateLimit: z.object({
    /**
     * P0-3 — Master switch. When false the middleware is not mounted and
     * neither admin nor gateway routes are throttled. Default true (secure-
     * by-default); operators with their own upstream throttling (nginx,
     * envoy, ALB) can opt out.
     */
    enabled: z.boolean().default(true),
    /** Token bucket capacity (burst size). */
    adminCapacity: z.number().int().positive().default(60),
    /** Tokens added per second to each admin bucket. */
    adminRefillPerSec: z.number().positive().default(10),
    /** Token bucket capacity for gateway routes. */
    gatewayCapacity: z.number().int().positive().default(120),
    /** Tokens added per second to each gateway bucket. */
    gatewayRefillPerSec: z.number().positive().default(20),
  }).default({
    enabled: true,
    adminCapacity: 60,
    adminRefillPerSec: 10,
    gatewayCapacity: 120,
    gatewayRefillPerSec: 20,
  }),

  auth: z.object({
    stdioToken: z.string().optional(),
    metricsAuthOptional: z.boolean().default(false),
    jwt: z.object({
      secret: z.string().min(32),
      accessExpiresIn: z.number().default(7200),
      refreshExpiresIn: z.number().default(604800),
      issuer: z.string().default("skill-mcp"),
    }).optional(),
  }).default({}),
});

export type AppConfig = z.infer<typeof configSchema>;
