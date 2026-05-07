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
  authTokenRefreshUrl: z.string().url().optional(),
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
    mode: z.enum(["standalone", "gateway", "cloud-service-only"]).default("standalone"),
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
  }).default({
    enableInjectionScan: true,
  }),

  apiKey: z.object({
    enabled: z.boolean().default(false),
    keys: z.array(z.string()).default([]),
  }).optional(),
});

export type AppConfig = z.infer<typeof configSchema>;
