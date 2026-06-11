import { randomUUID, createHash } from "node:crypto";
import { DEFAULT_TENANT_ID, type RequestContext } from "../types/index.js";
import type { UserRepository } from "../db/repositories/user.repository.js";
import type { UserRoleRepository } from "../db/repositories/user-role.repository.js";
import type { OidcVerifier, VerifiedJwt } from "../auth/oidc-verifier.js";
import type { OidcProvisioner } from "../auth/oidc-provisioner.js";
import { JwtVerificationError } from "../utils/errors.js";
import { withSpan } from "../telemetry/spans.js";

export interface McpExtra {
  sessionId?: string;
  authInfo?: { token?: string };
}

/**
 * P1-14 stage 2 — optional OIDC verification path. When configured, a
 * bearer token shaped like a JWT is run through the verifier first and a
 * synthetic `oidc:<iss>:<sub>` context is returned on success. Native
 * opaque-token authentication keeps working unchanged for non-JWT tokens.
 * Stage 3 will replace the synthetic userId with auto-provisioned DB rows
 * keyed by `(issuer, subject)`.
 */
export interface OidcContextOptions {
  verifier: OidcVerifier;
  /** Claim used as the subject. Defaults to `sub`. */
  userClaim?: string;
  /** Claim from which to derive the tag set. Defaults to `groups`. */
  groupsClaim?: string;
  /** Optional logger; warns when verification fails (no-op when omitted). */
  logger?: { warn: (obj: object, msg: string) => void };
  /**
   * P1-14 stage 3 — when wired, a verified JWT triggers auto-provisioning of
   * a real user row + group→role grants instead of returning a synthetic
   * `oidc:<iss>:<sub>` userId. Absent: stage 2 behavior preserved.
   */
  provisioner?: OidcProvisioner;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// JWTs match this shape exactly: three base64url segments separated by `.`.
// Tokens that fail this regex are treated as opaque so legacy callers keep
// working — a real JWT never contains characters outside [A-Za-z0-9_-].
const JWT_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function looksLikeJwt(token: string): boolean {
  return JWT_SHAPE_RE.test(token);
}

function anonymousContext(sessionId: string): RequestContext {
  return { tenantId: DEFAULT_TENANT_ID, userId: "anonymous", sessionId, tags: new Set(), isAuthenticated: false };
}

async function contextFromOidc(
  verified: VerifiedJwt,
  sessionId: string,
  opts: OidcContextOptions,
): Promise<RequestContext> {
  const userClaim = opts.userClaim ?? "sub";
  const groupsClaim = opts.groupsClaim ?? "groups";
  const subject = verified.payload[userClaim];
  if (typeof subject !== "string" || !subject) {
    // Token verified cryptographically but lacks a usable subject claim.
    // Treat as anonymous rather than synthesising a userId we can't trust.
    return anonymousContext(sessionId);
  }
  const issuer = typeof verified.payload.iss === "string" ? verified.payload.iss : "<unknown>";

  // Collect tags from the JWT group claim — this is the always-on baseline,
  // independent of whether the operator has wired auto-provisioning.
  const groupTags = new Set<string>();
  const groups = verified.payload[groupsClaim];
  if (Array.isArray(groups)) {
    for (const g of groups) {
      if (typeof g === "string" && g.trim()) groupTags.add(g.trim());
    }
  }

  // P1-14 stage 3 — auto-provision when wired. Returns a real `users.id`
  // and merges DB-resident role tags with the group-claim tags so the
  // permission filter sees the union. If provisioning fails for any reason,
  // we fall back to stage-2 synthetic context rather than denying the
  // caller — the caller's JWT was cryptographically valid.
  if (opts.provisioner) {
    try {
      const result = await opts.provisioner.provisionFromJwt(verified.payload, { userClaim, groupsClaim });
      if (result) {
        const tags = new Set<string>([...groupTags, ...result.tags]);
        return {
          tenantId: result.tenantId,
          userId: result.userId,
          sessionId,
          tags,
          isAuthenticated: true,
        };
      }
    } catch (err) {
      opts.logger?.warn?.({ err, issuer, subject }, "OIDC auto-provisioning failed; falling back to synthetic identity");
    }
  }

  // Stage-2 fallback: synthetic userId, tags from group claim only.
  const userId = `oidc:${issuer}:${subject}`;
  return { tenantId: DEFAULT_TENANT_ID, userId, sessionId, tags: groupTags, isAuthenticated: true };
}

/**
 * T-504 — single resolution path. Both MCP-tool callers and HTTP middleware
 * arrive here once they've extracted (token, sessionId). Anonymous fall-through
 * is consistent: missing token, unknown token, or disabled user all collapse
 * to the same anonymous context. Keeping this in one place prevents the two
 * code paths from drifting (e.g. one validating user.status, the other not).
 *
 * P1-14 stage 2 — when an OIDC verifier is wired and the token shape matches
 * a JWT, OIDC verification runs first. A JWT-shaped token that fails
 * verification collapses to anonymous rather than falling through to the
 * sha256 opaque-token lookup: a malformed/expired/wrong-issuer JWT is a real
 * authentication failure, not a hint to try a different scheme.
 */
async function resolveContextForToken(
  token: string | null | undefined,
  sessionId: string,
  userRepo: UserRepository,
  userRoleRepo: UserRoleRepository,
  oidc?: OidcContextOptions,
): Promise<RequestContext> {
  // P0-6 — `auth.resolve` span (§17.6). `auth.has_token` distinguishes the
  // anonymous fall-through from real authentication; we deliberately do not
  // attach the token (or its hash) to span attributes to avoid leaking
  // credentials into trace storage. `auth.scheme` is added in stage 2 so
  // operators can see which path served a request without logging the token.
  return withSpan("auth.resolve", { attributes: { "auth.has_token": Boolean(token) } }, async () => {
    if (!token) {
      return anonymousContext(sessionId);
    }

    if (oidc && looksLikeJwt(token)) {
      try {
        const verified = await oidc.verifier.verify(token);
        return await contextFromOidc(verified, sessionId, oidc);
      } catch (err) {
        if (err instanceof JwtVerificationError) {
          oidc.logger?.warn?.({ reason: err.reason }, "OIDC token verification failed");
          return anonymousContext(sessionId);
        }
        throw err;
      }
    }

    const hash = sha256(token);
    const user = await userRepo.findByToken(hash);
    if (!user || user.status !== "active") {
      return anonymousContext(sessionId);
    }

    const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);
    return { tenantId: user.tenantId ?? DEFAULT_TENANT_ID, userId: user.id, sessionId, tags: new Set(tags), isAuthenticated: true };
  });
}

export function buildRequestContext(
  extra: McpExtra,
  userRepo: UserRepository,
  userRoleRepo: UserRoleRepository,
  oidc?: OidcContextOptions,
): Promise<RequestContext> {
  const sessionId = extra.sessionId ?? randomUUID();
  return resolveContextForToken(extra.authInfo?.token, sessionId, userRepo, userRoleRepo, oidc);
}

export function buildRequestContextFromHttp(
  token: string | null,
  sessionId: string,
  userRepo: UserRepository,
  userRoleRepo: UserRoleRepository,
  oidc?: OidcContextOptions,
): Promise<RequestContext> {
  return resolveContextForToken(token, sessionId, userRepo, userRoleRepo, oidc);
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
  oidc?: OidcContextOptions,
): ContextBuilder {
  return (extra: McpExtra) => buildRequestContext(extra, userRepo, userRoleRepo, oidc);
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
