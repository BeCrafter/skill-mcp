import { configSchema, type AppConfig } from "./schema.js";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const APP_VERSION = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

function getDefaultDataDir(): string {
  const userHome = homedir();
  return join(userHome, ".skill-mcp");
}

function loadConfig(): AppConfig {
  const defaultDataDir = getDefaultDataDir();
  const defaultDbPath = join(defaultDataDir, "skill-mcp.db");
  const defaultStoragePath = join(defaultDataDir, "data", "skills");
  const defaultCachePath = join(defaultDataDir, "cache");

  // Start with env-based defaults
  const envConfig = {
    app: {
      version: APP_VERSION,
      env: process.env.NODE_ENV ?? "development",
    },
    deployment: {
      mode: (process.env.DEPLOYMENT_MODE as "standalone" | "gateway") ?? "standalone",
    },
    gateway: process.env.CLOUD_SERVICE_URL
      ? {
          cloudServiceUrl: process.env.CLOUD_SERVICE_URL,
          authToken: process.env.AUTH_TOKEN ?? "",
        }
      : undefined,
    database: {
      // P0-8 — DATABASE_URL takes precedence over DATABASE_PATH. URL format
      // (`sqlite://...` / `postgres://...`) lets the dialect factory pick the
      // right driver. DATABASE_PATH remains supported as a bare-path shortcut
      // for the SQLite default install.
      path: process.env.DATABASE_URL ?? process.env.DATABASE_PATH ?? defaultDbPath,
    },
    storage: {
      type: (process.env.STORAGE_TYPE as "local-fs") ?? "local-fs",
      basePath: process.env.STORAGE_BASE_PATH ?? defaultStoragePath,
    } as const,
    cache: {
      memory: {
        enabled: process.env.CACHE_MEMORY_ENABLED !== "false",
        maxSize: parseInt(process.env.CACHE_MEMORY_MAX_SIZE ?? "500", 10),
      },
      file: {
        enabled: process.env.CACHE_FILE_ENABLED !== "false",
        cacheDir: process.env.CACHE_FILE_DIR ?? defaultCachePath,
      },
    },
    transport: {
      type: (process.env.TRANSPORT_TYPE as "stdio" | "sse" | "http") ?? "stdio",
      port: parseInt(process.env.TRANSPORT_PORT ?? "3000", 10),
      host: process.env.TRANSPORT_HOST ?? "0.0.0.0",
      mcpOnlyMode: process.env.MCP_ONLY_MODE === "true",
    },
    security: {
      enableInjectionScan: process.env.SECURITY_INJECTION_SCAN !== "false",
      hstsEnabled: process.env.SECURITY_HSTS_ENABLED === "true",
    },
    auth: {
      stdioToken: process.env.SKILL_MCP_AUTH_TOKEN,
      adminAuthOptional: process.env.SKILL_MCP_ADMIN_AUTH_OPTIONAL === "true",
      metricsAuthOptional: process.env.SKILL_MCP_METRICS_AUTH_OPTIONAL === "true",
      oidc: process.env.OIDC_ISSUER && process.env.OIDC_AUDIENCE && process.env.OIDC_JWKS_URI
        ? {
            issuer: process.env.OIDC_ISSUER,
            audience: process.env.OIDC_AUDIENCE.includes(",")
              ? process.env.OIDC_AUDIENCE.split(",").map((s) => s.trim()).filter(Boolean)
              : process.env.OIDC_AUDIENCE,
            jwksUri: process.env.OIDC_JWKS_URI,
            userClaim: process.env.OIDC_USER_CLAIM ?? "sub",
            groupsClaim: process.env.OIDC_GROUPS_CLAIM ?? "groups",
            clockSkewSec: parseInt(process.env.OIDC_CLOCK_SKEW_SEC ?? "60", 10),
            jwksTtlMs: parseInt(process.env.OIDC_JWKS_TTL_MS ?? "600000", 10),
            allowedAlgorithms: (process.env.OIDC_ALLOWED_ALGORITHMS ?? "RS256")
              .split(",").map((s) => s.trim()).filter(Boolean),
          }
        : undefined,
    },
    rateLimit: {
      enabled: process.env.RATE_LIMIT_ENABLED !== "false",
      adminCapacity: parseInt(process.env.RATE_LIMIT_ADMIN_CAPACITY ?? "60", 10),
      adminRefillPerSec: parseFloat(process.env.RATE_LIMIT_ADMIN_REFILL_PER_SEC ?? "10"),
      gatewayCapacity: parseInt(process.env.RATE_LIMIT_GATEWAY_CAPACITY ?? "120", 10),
      gatewayRefillPerSec: parseFloat(process.env.RATE_LIMIT_GATEWAY_REFILL_PER_SEC ?? "20"),
    },
  };

  // Load config file if exists
  const configPath = process.env.SKILL_MCP_CONFIG;
  if (configPath && existsSync(configPath)) {
    try {
      const fileContent = readFileSync(configPath, "utf-8");
      const fileConfig = JSON.parse(fileContent);
      const merged = deepMerge(envConfig, fileConfig);
      return configSchema.parse(merged);
    } catch (error) {
      console.warn(`Failed to load config from ${configPath}:`, error);
    }
  }

  const config = configSchema.parse(envConfig);

  // Ensure data directories exist
  const dbDir = dirname(config.database.path);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  if (config.storage.type === "local-fs") {
    if (!existsSync(config.storage.basePath)) {
      mkdirSync(config.storage.basePath, { recursive: true });
    }
  }

  if (config.cache.file.enabled) {
    if (!existsSync(config.cache.file.cacheDir)) {
      mkdirSync(config.cache.file.cacheDir, { recursive: true });
    }
  }

  return config;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const targetVal = result[key];
    const sourceVal = source[key];
    if (
      targetVal && sourceVal &&
      typeof targetVal === "object" && !Array.isArray(targetVal) &&
      typeof sourceVal === "object" && !Array.isArray(sourceVal)
    ) {
      result[key] = deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>);
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

// Singleton config
let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}

/**
 * Build a fresh AppConfig from the current process environment, bypassing
 * the module-level singleton cache. Use this in tests so cases never need
 * to reach into the shared `_config` slot via `resetConfig()`.
 */
export function createConfig(): AppConfig {
  return loadConfig();
}

export type { AppConfig };
export { configSchema, getDefaultDataDir };
