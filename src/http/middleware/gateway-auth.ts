import { randomUUID } from "node:crypto";
import type { HttpContext } from "../context.js";
import type { UserRepository } from "../../db/repositories/user.repository.js";
import type { UserRoleRepository } from "../../db/repositories/user-role.repository.js";
import type { RequestContext } from "../../types/index.js";
import { extractBearerToken, buildRequestContextFromHttp } from "../../permission/context-builder.js";
import { json } from "../helpers.js";

export interface GatewayAuthDeps {
  userRepo?: UserRepository;
  userRoleRepo?: UserRoleRepository;
}

/**
 * Authenticate a request hitting `/api/gateway/*` (except `/api/gateway/health`).
 *
 * Returns the resolved `RequestContext` on success. Returns `null` after writing
 * a 401/500 response when the request is rejected — the caller must stop
 * processing the request in that case.
 */
export async function enforceGatewayAuth(
  ctx: HttpContext,
  deps: GatewayAuthDeps,
): Promise<RequestContext | null> {
  if (!deps.userRepo || !deps.userRoleRepo) {
    ctx.logger.warn(
      { url: ctx.url },
      "Gateway auth misconfigured: userRepo/userRoleRepo missing — refusing request",
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
  );

  if (!requestContext.isAuthenticated) {
    json(ctx.res, 401, { success: false, error: "Invalid or expired token" });
    return null;
  }

  return requestContext;
}
