import { randomUUID, createHash } from "node:crypto";
import type { RequestContext } from "../types/index.js";
import type { UserRepository } from "../db/repositories/user.repository.js";
import type { UserRoleRepository } from "../db/repositories/user-role.repository.js";

export interface McpExtra {
  sessionId?: string;
  authInfo?: { token?: string };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function buildRequestContext(
  extra: McpExtra,
  userRepo: UserRepository,
  userRoleRepo: UserRoleRepository,
): Promise<RequestContext> {
  const sessionId = extra.sessionId ?? randomUUID();

  const token = extra.authInfo?.token;
  if (!token) {
    return { userId: "anonymous", sessionId, tags: new Set(), isAuthenticated: false };
  }

  const hash = sha256(token);
  const user = await userRepo.findByToken(hash);
  if (!user || user.status !== "active") {
    return { userId: "anonymous", sessionId, tags: new Set(), isAuthenticated: false };
  }

  const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);
  return { userId: user.id, sessionId, tags: new Set(tags), isAuthenticated: true };
}

export async function buildRequestContextFromHttp(
  token: string | null,
  sessionId: string,
  userRepo: UserRepository,
  userRoleRepo: UserRoleRepository,
): Promise<RequestContext> {
  if (!token) {
    return { userId: "anonymous", sessionId, tags: new Set(), isAuthenticated: false };
  }

  const hash = sha256(token);
  const user = await userRepo.findByToken(hash);
  if (!user || user.status !== "active") {
    return { userId: "anonymous", sessionId, tags: new Set(), isAuthenticated: false };
  }

  const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);
  return { userId: user.id, sessionId, tags: new Set(tags), isAuthenticated: true };
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim() || null;
}

export type ContextBuilder = (extra: McpExtra) => Promise<RequestContext>;

export function createContextBuilder(
  userRepo: UserRepository,
  userRoleRepo: UserRoleRepository,
): ContextBuilder {
  return (extra: McpExtra) => buildRequestContext(extra, userRepo, userRoleRepo);
}

/**
 * Wraps a base context builder so that, when the caller does not supply
 * `extra.authInfo.token`, a fallback token (e.g. injected at stdio startup
 * from SKILL_MCP_AUTH_TOKEN / --auth-token) is used instead. Per-request the
 * underlying builder still does the sha256 + DB lookup, so role/tag changes
 * apply without restart.
 */
export function withFallbackToken(
  base: ContextBuilder,
  fallbackToken: string | undefined,
): ContextBuilder {
  if (!fallbackToken) return base;
  return (extra: McpExtra) => {
    if (!extra.authInfo?.token) {
      return base({ ...extra, authInfo: { token: fallbackToken } });
    }
    return base(extra);
  };
}
