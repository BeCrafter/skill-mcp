import { z } from "zod";

export const storageConfigSchema = z.object({
  type: z.literal("local-fs").default("local-fs"),
  basePath: z.string().default("./data/skills"),
}).default({ type: "local-fs", basePath: "./data/skills" });

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
    version: z.string().default("0.1.0"),
    env: z.enum(["development", "production", "test"]).default("development"),
  }),
  deployment: z.object({
    mcpOnly: z.boolean().default(false),
    apiOnly: z.boolean().default(false),
  }).refine((d) => !(d.mcpOnly && d.apiOnly), {
    message: "mcpOnly and apiOnly cannot both be true",
  }),
  gateway: z.object({
    // C2 remote-proxy mode: when set, `serve` fronts a remote storage Registry
    // via RemoteSkillProvider instead of using local SQLite+fs. Absent/empty
    // means local mode.
    cloudServiceUrl: z.string().url().optional(),
  }).default({}),
  storage: storageConfigSchema,
  database: z.object({ path: z.string().min(1) }),
  cache: cacheConfigSchema,
  transport: z.object({
    type: z.enum(["stdio", "sse", "http"]).default("stdio"),
    port: z.number().int().positive().default(3000),
  }).default({ type: "stdio", port: 3000 }),
  security: z.object({
    enableInjectionScan: z.boolean().default(true),
    hstsEnabled: z.boolean().default(false),
  }).default({ enableInjectionScan: true, hstsEnabled: false }),
  rateLimit: z.object({
    enabled: z.boolean().default(true),
    adminCapacity: z.number().int().positive().default(60),
    adminRefillPerSec: z.number().positive().default(10),
    gatewayCapacity: z.number().int().positive().default(120),
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
}).strict();

export type AppConfig = z.infer<typeof configSchema>;
