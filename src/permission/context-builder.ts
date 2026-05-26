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

/**
 * T-504 — single resolution path. Both MCP-tool callers and HTTP middleware
 * arrive here once they've extracted (token, sessionId). Anonymous fall-through
 * is consistent: missing token, unknown token, or disabled user all collapse
 * to the same anonymous context. Keeping this in one place prevents the two
 * code paths from drifting (e.g. one validating user.status, the other not).
 */
async function resolveContextForToken(
  token: string | null | undefined,
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

export function buildRequestContext(
  extra: McpExtra,
  userRepo: UserRepository,
  userRoleRepo: UserRoleRepository,
): Promise<RequestContext> {
  const sessionId = extra.sessionId ?? randomUUID();
  return resolveContextForToken(extra.authInfo?.token, sessionId, userRepo, userRoleRepo);
}

export function buildRequestContextFromHttp(
  token: string | null,
  sessionId: string,
  userRepo: UserRepository,
  userRoleRepo: UserRoleRepository,
): Promise<RequestContext> {
  return resolveContextForToken(token, sessionId, userRepo, userRoleRepo);
}

// Cap parsed header length to bound work on hostile input. 4 KiB comfortably
// fits any legitimate opaque bearer token (including JWT) while preventing
// pathological allocations during string ops on attacker-controlled headers.
const MAX_AUTH_HEADER_BYTES = 4096;
// JWTs in production routinely run 1.5–3 KiB. The hard ceiling tracks the
// header limit so an attacker cannot pad below it to bypass the per-token
// guard.
const MAX_TOKEN_BYTES = 4096;
const BEARER_PREFIX = /^bearer\s+/i;

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  if (authHeader.length > MAX_AUTH_HEADER_BYTES) return null;
  const trimmed = authHeader.trim();
  const match = trimmed.match(BEARER_PREFIX);
  if (!match) return null;
  const token = trimmed.slice(match[0].length).trim();
  if (!token || token.length > MAX_TOKEN_BYTES) return null;
  return token;
}

/**
 * T-738 — bridge `Authorization: Bearer <token>` from a Node IncomingMessage
 * onto `req.auth.token`, which is the contract the MCP SDK transports
 * (`StreamableHTTPServerTransport.handleRequest`, `SSEServerTransport.
 * handlePostMessage`) read to populate `extra.authInfo` on tool calls.
 *
 * Without this step the HTTP / SSE MCP transports always saw an empty
 * `authInfo`, collapsing every authenticated caller to anonymous on the
 * MCP surface (gateway REST surface was unaffected because it builds the
 * RequestContext directly via `enforceGatewayAuth`). Idempotent: skips when
 * `req.auth` is already set so future middleware / tests can pre-populate.
 */
export function attachMcpAuthFromHeaders(
  req: { headers: { authorization?: string | string[] }; auth?: { token?: string } },
): void {
  if (req.auth) return;
  const header = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const token = extractBearerToken(header);
  if (token) {
    req.auth = { token };
  }
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
