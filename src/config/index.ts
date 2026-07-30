import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { configSchema, type AppConfig } from "./schema.js";

const APP_VERSION = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

function readLocalJwtSecret(): string | undefined {
  const configPath = join(homedir(), ".skill-mcp", "config.json");
  if (!existsSync(configPath)) return undefined;
  try {
    return (JSON.parse(readFileSync(configPath, "utf-8")) as { jwt_secret?: string }).jwt_secret;
  } catch {
    return undefined;
  }
}

function getDefaultDataDir(): string {
  return join(homedir(), ".skill-mcp");
}

function rejectRemovedEnvironment(): void {
  // CLOUD_SERVICE_URL is intentionally allowed: it enables C2 remote-proxy
  // mode (RemoteSkillProvider fronts a remote storage Registry). It is not a
  // generic backend switch — see docs/releases/v0.1.md.
  if (process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is no longer supported: set DATABASE_PATH to a SQLite file path.");
  }
  if (process.env.STORAGE_TYPE && process.env.STORAGE_TYPE !== "local-fs") {
    throw new Error(`STORAGE_TYPE=${process.env.STORAGE_TYPE} is no longer supported: migrate OSS data before using local-fs.`);
  }
}

function loadConfig(): AppConfig {
  try {
    rejectRemovedEnvironment();
    const dataDir = getDefaultDataDir();
    const envConfig = {
      app: { version: APP_VERSION, env: process.env.NODE_ENV ?? "development" },
      deployment: {
        mcpOnly: process.env.MCP_ONLY_MODE === "true",
        apiOnly: process.env.API_ONLY_MODE === "true",
      },
      gateway: {
        cloudServiceUrl: process.env.CLOUD_SERVICE_URL || undefined,
      },
      database: { path: process.env.DATABASE_PATH ?? join(dataDir, "skill-mcp.db") },
      storage: {
        type: "local-fs" as const,
        basePath: process.env.STORAGE_BASE_PATH ?? join(dataDir, "data", "skills"),
      },
      cache: {
        memory: {
          enabled: process.env.CACHE_MEMORY_ENABLED !== "false",
          maxSize: parseInt(process.env.CACHE_MEMORY_MAX_SIZE ?? "500", 10),
        },
        file: {
          enabled: process.env.CACHE_FILE_ENABLED !== "false",
          cacheDir: process.env.CACHE_FILE_DIR ?? join(dataDir, "cache"),
        },
      },
      transport: {
        type: process.env.TRANSPORT_TYPE ?? "stdio",
        port: parseInt(process.env.TRANSPORT_PORT ?? "3000", 10),
      },
      security: {
        enableInjectionScan: process.env.SECURITY_INJECTION_SCAN !== "false",
        hstsEnabled: process.env.SECURITY_HSTS_ENABLED === "true",
      },
      auth: {
        stdioToken: process.env.SKILL_MCP_AUTH_TOKEN,
        metricsAuthOptional: process.env.SKILL_MCP_METRICS_AUTH_OPTIONAL === "true",
        jwt: (() => {
          const secret = process.env.AUTH_JWT_SECRET || readLocalJwtSecret();
          return secret ? {
            secret,
            accessExpiresIn: parseInt(process.env.AUTH_JWT_ACCESS_EXPIRES_IN ?? "7200", 10),
            refreshExpiresIn: parseInt(process.env.AUTH_JWT_REFRESH_EXPIRES_IN ?? "604800", 10),
            issuer: process.env.AUTH_JWT_ISSUER ?? "skill-mcp",
          } : undefined;
        })(),
      },
      rateLimit: {
        enabled: process.env.RATE_LIMIT_ENABLED !== "false",
        adminCapacity: parseInt(process.env.RATE_LIMIT_ADMIN_CAPACITY ?? "60", 10),
        adminRefillPerSec: parseFloat(process.env.RATE_LIMIT_ADMIN_REFILL_PER_SEC ?? "10"),
        gatewayCapacity: parseInt(process.env.RATE_LIMIT_GATEWAY_CAPACITY ?? "120", 10),
        gatewayRefillPerSec: parseFloat(process.env.RATE_LIMIT_GATEWAY_REFILL_PER_SEC ?? "20"),
      },
    };

    const configPath = process.env.SKILL_MCP_CONFIG;
    if (configPath && existsSync(configPath)) {
      const fileConfig = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      return configSchema.parse(deepMerge(envConfig, fileConfig));
    }
    return configSchema.parse(envConfig);
  } catch (error) {
    console.error("Invalid configuration:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export function ensureDirectories(config: AppConfig): void {
  const dirs = [dirname(config.database.path), config.storage.basePath];
  if (config.cache.file.enabled) dirs.push(config.cache.file.cacheDir);
  for (const dir of dirs) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const left = result[key];
    const right = source[key];
    result[key] = left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)
      ? deepMerge(left as Record<string, unknown>, right as Record<string, unknown>)
      : right;
  }
  return result;
}

let configSingleton: AppConfig | null = null;
export function getConfig(): AppConfig {
  configSingleton ??= loadConfig();
  return configSingleton;
}
export function createConfig(): AppConfig { return loadConfig(); }
export { configSchema, getDefaultDataDir };
