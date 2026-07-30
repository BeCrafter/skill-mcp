import { randomUUID } from "node:crypto";
import { type RequestContext } from "../types/index.js";
import type { UserRepository } from "../db/repositories/user.repository.js";
import type { UserRoleRepository } from "../db/repositories/user-role.repository.js";
import { looksLikeJwt, verifyJwt } from "../utils/jwt.js";
import { sha256 } from "../utils/crypto.js";
import { getLogger } from "../utils/logger.js";
import { AuthenticationError } from "../utils/errors.js";

const logger = getLogger();

export interface McpExtra {
  sessionId?: string;
  authInfo?: { token?: string };
}

function anonymousContext(sessionId: string): RequestContext {
  return { userId: "anonymous", sessionId, tags: new Set(), isAuthenticated: false, userType: undefined };
}

async function resolveContextForToken(
  token: string | null | undefined,
  sessionId: string,
  userRepo: UserRepository,
  userRoleRepo: UserRoleRepository,
  jwtSecret?: string,
  jwtIssuer?: string,
  expectedIssuer?: string,
): Promise<RequestContext> {
  if (!token) return anonymousContext(sessionId);
  if (looksLikeJwt(token) && jwtSecret && expectedIssuer) {
    try {
      const payload = await verifyJwt(token, jwtSecret, expectedIssuer);
      const user = await userRepo.findById(payload.sub);
      if (!user || user.status !== "active") throw new AuthenticationError("User not found or disabled");
      return {
        userId: payload.sub,
        sessionId,
        tags: new Set<string>(Array.isArray(payload.tags) ? payload.tags : []),
        isAuthenticated: true,
        userType: user.userType as "superadmin" | "admin" | "user" | undefined,
      };
    } catch (err) {
      if (err instanceof AuthenticationError) throw err;
      logger.warn({ reason: err instanceof Error ? err.message : "unknown" }, "JWT verification failed");
      throw new AuthenticationError("Invalid or expired token");
    }
  }
  const user = await userRepo.findByToken(sha256(token));
  if (!user || user.status !== "active") throw new AuthenticationError("Invalid or expired token");
  const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);
  return {
    userId: user.id, sessionId, tags: new Set(tags), isAuthenticated: true,
    userType: user.userType as "superadmin" | "admin" | "user" | undefined,
  };
}

export function buildRequestContext(
  extra: McpExtra,
  userRepo: UserRepository,
  userRoleRepo: UserRoleRepository,
  jwtSecret?: string,
  jwtIssuer?: string,
): Promise<RequestContext> {
  return resolveContextForToken(extra.authInfo?.token, extra.sessionId ?? randomUUID(), userRepo, userRoleRepo, jwtSecret, jwtIssuer, jwtIssuer);
}

export function buildRequestContextFromHttp(
  token: string | null,
  sessionId: string,
  userRepo: UserRepository,
  userRoleRepo: UserRoleRepository,
  jwtSecret?: string,
  jwtIssuer?: string,
): Promise<RequestContext> {
  return resolveContextForToken(token, sessionId, userRepo, userRoleRepo, jwtSecret, jwtIssuer, jwtIssuer);
}

const MAX_AUTH_HEADER_BYTES = 4096;
const MAX_TOKEN_BYTES = 4096;
const BEARER_PREFIX = /^bearer\s+/i;

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || authHeader.length > MAX_AUTH_HEADER_BYTES) return null;
  const match = authHeader.trim().match(BEARER_PREFIX);
  if (!match) return null;
  const token = authHeader.trim().slice(match[0].length).trim();
  return token && token.length <= MAX_TOKEN_BYTES ? token : null;
}

export function attachMcpAuthFromHeaders(req: { headers: { authorization?: string | string[] }; auth?: { token?: string } }): void {
  if (req.auth) return;
  const header = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  const token = extractBearerToken(header);
  if (token) req.auth = { token };
}

export type ContextBuilder = (extra: McpExtra) => Promise<RequestContext>;
export function createContextBuilder(userRepo: UserRepository, userRoleRepo: UserRoleRepository, jwtSecret?: string, jwtIssuer?: string): ContextBuilder {
  return (extra) => buildRequestContext(extra, userRepo, userRoleRepo, jwtSecret, jwtIssuer);
}
export function withFallbackToken(base: ContextBuilder, fallbackToken: string | undefined): ContextBuilder {
  if (!fallbackToken) return base;
  return (extra) => base(extra.authInfo?.token ? extra : { ...extra, authInfo: { token: fallbackToken } });
}
