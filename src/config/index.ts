import { configSchema, type AppConfig } from "./schema.js";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function loadConfig(): AppConfig {
  // Start with env-based defaults
  const envConfig = {
    app: {
      env: process.env.NODE_ENV ?? "development",
    },
    deployment: {
      mode: (process.env.DEPLOYMENT_MODE as "standalone" | "gateway") ?? "standalone",
    },
    gateway: process.env.CLOUD_SERVICE_URL
      ? {
          cloudServiceUrl: process.env.CLOUD_SERVICE_URL,
          authToken: process.env.AUTH_TOKEN ?? "",
          authTokenRefreshUrl: process.env.AUTH_TOKEN_REFRESH_URL,
        }
      : undefined,
    database: {
      path: process.env.DATABASE_PATH ?? "./data/skill-mcp.db",
    },
    storage: {
      type: (process.env.STORAGE_TYPE as "local-fs") ?? "local-fs",
      basePath: process.env.STORAGE_BASE_PATH ?? "./data/skills",
    } as const,
    cache: {
      memory: {
        enabled: process.env.CACHE_MEMORY_ENABLED !== "false",
        maxSize: parseInt(process.env.CACHE_MEMORY_MAX_SIZE ?? "500", 10),
      },
      file: {
        enabled: process.env.CACHE_FILE_ENABLED !== "false",
        cacheDir: process.env.CACHE_FILE_DIR ?? "./data/cache",
      },
    },
    transport: {
      type: (process.env.TRANSPORT_TYPE as "stdio" | "sse" | "http") ?? "stdio",
      port: parseInt(process.env.TRANSPORT_PORT ?? "3000", 10),
      host: process.env.TRANSPORT_HOST ?? "0.0.0.0",
    },
    security: {
      enableInjectionScan: process.env.SECURITY_INJECTION_SCAN !== "false",
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

export type { AppConfig };
export { configSchema };
