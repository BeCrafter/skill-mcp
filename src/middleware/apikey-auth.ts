import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { getLogger } from "../utils/logger.js";
import { getConfig } from "../config/index.js";

const logger = getLogger();

export interface ApiKeyConfig {
  enabled: boolean;
  keys: string[];
}

export function createApiKeyAuthMiddleware(config: ApiKeyConfig) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!config.enabled) {
      return true;
    }

    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      logger.warn({ path: req.url }, "Missing or invalid Authorization header");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing Authorization header" }));
      return false;
    }

    const token = authHeader.slice(7).trim(); // Trim whitespace to prevent bypass
    // Use constant-time comparison to prevent timing attacks
    const isValid = config.keys.some(key => {
      if (token.length !== key.length) return false;
      try {
        return timingSafeEqual(Buffer.from(token), Buffer.from(key));
      } catch {
        return false;
      }
    });

    if (!isValid) {
      logger.warn({ path: req.url }, "Invalid API key");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid API key" }));
      return false;
    }

    logger.debug({ path: req.url }, "API key authentication passed");
    return true;
  };
}

export function getApiKeyConfig(): ApiKeyConfig {
  const config = getConfig();
  return config.apiKey || { enabled: false, keys: [] };
}
