import { randomUUID } from "node:crypto";
import type { HttpContext } from "../context.js";
import type { UserRepository } from "../../db/repositories/user.repository.js";
import type { UserRoleRepository } from "../../db/repositories/user-role.repository.js";
import { DEFAULT_TENANT_ID, type RequestContext } from "../../types/index.js";
import {
  extractBearerToken,
  buildRequestContextFromHttp,
  type OidcContextOptions,
} from "../../permission/context-builder.js";
import { json } from "../helpers.js";

export interface AdminAuthDeps {
  userRepo?: UserRepository;
  userRoleRepo?: UserRoleRepository;
  oidc?: OidcContextOptions;
  /**
   * Backwards-compat: when true, admin auth is bypassed entirely. Intended only
   * for legacy deployments transitioning off network-isolation-only protection.
   * The caller must log a warning at startup if this is set; the middleware
   * itself never logs per-request to keep hot-path noise down.
   */
  authOptional?: boolean;
}

/** Tag a token must carry on at least one of its roles to access admin routes. */
export const ADMIN_WRITE_TAG = "admin:write";

/**
 * Authenticate a request hitting `/api/admin/*`.
 *
 * Returns the resolved `RequestContext` on success. Returns `null` after writing
 * a 401/403/500 response when the request is rejected — the caller must stop
 * processing the request in that case.
 *
 * Policy:
 *   - missing/invalid token → 401
 *   - authenticated but lacking `admin:write` tag → 403
 *   - authenticated with `admin:write` tag → pass
 *   - authOptional=true (legacy) → pass with anonymous context
 */
export async function enforceAdminAuth(
  ctx: HttpContext,
  deps: AdminAuthDeps,
): Promise<RequestContext | null> {
  if (deps.authOptional) {
    // Legacy escape hatch (SKILL_MCP_ADMIN_AUTH_OPTIONAL=true). Synthesizes a
    // context that carries the `admin:write` tag *but* sets isAuthenticated=false.
    // The split is deliberate: admin routes don't gate on isAuthenticated, but
    // TagPermissionFilter does — so a leaked anonymous-admin context cannot
    // read private/internal skills downstream (see src/permission/tag-filter.ts
    // — only `visibility="public"` skills are returned for unauthenticated
    // callers regardless of which tags they carry). Operators should remove
    // this env var as soon as the first real admin user is provisioned via
    // `skill-mcp user create --role admin`. Tracked for removal in T-004.
    return {
      tenantId: DEFAULT_TENANT_ID,
      userId: "anonymous-admin",
      sessionId: (ctx.req.headers["x-session-id"] as string) || randomUUID(),
      tags: new Set([ADMIN_WRITE_TAG]),
      isAuthenticated: false,
    };
  }

  if (!deps.userRepo || !deps.userRoleRepo) {
    ctx.logger.warn(
      { url: ctx.url },
      "Admin auth misconfigured: userRepo/userRoleRepo missing — refusing request",
    );
    json(ctx.res, 500, { success: false, error: "Server auth not configured" });
    return null;
  }

  const token = extractBearerToken(ctx.req.headers.authorization);
  if (!token) {
    json(ctx.res, 401, { success: false, error: "Authentication required" });
    return null;
  }

  const sessionId = (ctx.req.headers["x-session-id"] as string) || randomUUID();
  const requestContext = await buildRequestContextFromHttp(
    token,
    sessionId,
    deps.userRepo,
    deps.userRoleRepo,
    deps.oidc,
  );

  if (!requestContext.isAuthenticated) {
    json(ctx.res, 401, { success: false, error: "Invalid or expired token" });
    return null;
  }

  if (!requestContext.tags.has(ADMIN_WRITE_TAG)) {
    json(ctx.res, 403, { success: false, error: "Admin privilege required" });
    return null;
  }

  return requestContext;
}
