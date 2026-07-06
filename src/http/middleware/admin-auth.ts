import { randomUUID } from "node:crypto";
import type { HttpContext } from "../context.js";
import type { UserRepository } from "../../db/repositories/user.repository.js";
import type { UserRoleRepository } from "../../db/repositories/user-role.repository.js";
import type { RequestContext } from "../../types/index.js";
import {
  extractBearerToken,
  buildRequestContextFromHttp,
} from "../../permission/context-builder.js";
import { looksLikeJwt } from "../../utils/jwt.js"
import { AppError } from "../../utils/errors.js";
import { json } from "../helpers.js";

export interface AuthMiddlewareDeps {
  userRepo?: UserRepository;
  userRoleRepo?: UserRoleRepository;
  jwtSecret?: string;
  jwtIssuer?: string;
}

/**
 * Shared auth middleware. When `requireAdmin` is true, rejects non-admin/non-superadmin users.
 * Gateway routes pass `requireAdmin: false`; admin routes pass `requireAdmin: true`.
 */
export async function enforceAuth(
  ctx: HttpContext,
  deps: AuthMiddlewareDeps,
  opts: { requireAdmin?: boolean } = {},
): Promise<RequestContext | null> {
  if (!deps.userRepo || !deps.userRoleRepo) {
    ctx.logger.warn({ url: ctx.url }, "Auth misconfigured: userRepo/userRoleRepo missing");
    json(ctx.res, 500, { success: false, error: "Server auth not configured" });
    return null;
  }

  const token = extractBearerToken(ctx.req.headers.authorization);
  if (!token) {
    json(ctx.res, 401, { success: false, error: "Authentication required" });
    return null;
  }

  if (opts.requireAdmin) {
    if (!deps.jwtSecret && looksLikeJwt(token)) {
      ctx.logger.warn({ url: ctx.url }, "JWT-shaped token but AUTH_JWT_SECRET not configured");
    }
    if (deps.jwtSecret && !deps.jwtIssuer && looksLikeJwt(token)) {
      ctx.logger.warn({ url: ctx.url }, "JWT-shaped token but jwt issuer not configured");
    }
  }

  const sessionId = (ctx.req.headers["x-session-id"] as string) || randomUUID();
  let requestContext: RequestContext;
  try {
    requestContext = await buildRequestContextFromHttp(
      token, sessionId, deps.userRepo, deps.userRoleRepo, deps.jwtSecret, deps.jwtIssuer,
    );
  } catch {
    json(ctx.res, 401, { success: false, error: "Invalid or expired token" });
    return null;
  }

  if (!requestContext.isAuthenticated) {
    json(ctx.res, 401, { success: false, error: "Invalid or expired token" });
    return null;
  }

  if (opts.requireAdmin && requestContext.userType !== "admin" && requestContext.userType !== "superadmin") {
    json(ctx.res, 403, { success: false, error: "Admin privilege required" });
    return null;
  }

  return requestContext;
}

/** Admin auth — requires admin or superadmin userType. */
export function enforceAdminAuth(ctx: HttpContext, deps: AuthMiddlewareDeps): Promise<RequestContext | null> {
  return enforceAuth(ctx, deps, { requireAdmin: true });
}

export function requireSuperadmin(rc: RequestContext): void {
  if (rc.userType !== "superadmin") {
    throw new AppError("Superadmin privilege required", "SUPERADMIN_REQUIRED", 403);
  }
}

export function assertSuperadminProtected(
  target: { userType: string; id: string },
  operatorId: string,
): void {
  if (target.userType === "superadmin" && target.id !== operatorId) {
    throw new AppError("Cannot modify or delete superadmin", "SUPERADMIN_PROTECTED", 403);
  }
}
