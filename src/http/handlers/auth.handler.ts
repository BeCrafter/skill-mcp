import type { Router } from "../router.js";
import type { AppDependencies } from "../../app.js";
import { json, readJsonBody } from "../helpers.js";
import { AppError } from "../../utils/errors.js";
import { signAccessToken, signRefreshToken, verifyJwt, type JwtPayload } from "../../auth/jwt.service.js";
import { extractBearerToken } from "../../permission/context-builder.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger();

export function registerAuthRoutes(router: Router, deps: AppDependencies): void {
  if (!deps.userRepo || !deps.userRoleRepo) return;
  const { userRepo, userRoleRepo } = deps;

  const jwtSecret = deps.jwtSecret;
  const jwtIssuer = deps.jwtIssuer ?? "skill-mcp";
  const accessExpiresIn = deps.jwtAccessExpiresIn ?? 7200;
  const refreshExpiresIn = deps.jwtRefreshExpiresIn ?? 604800;

  if (!jwtSecret) return;

  // POST /api/auth/login
  router.post("/api/auth/login", async (ctx) => {
    const data = await readJsonBody<{ username?: string; password?: string }>(ctx.req);
    if (!data.username || !data.password) {
      throw new AppError("username and password required", "BAD_REQUEST", 400);
    }

    const user = await userRepo.findByUsername(data.username);
    if (!user || (user.userType !== "admin" && user.userType !== "superadmin")) {
      throw new AppError("Invalid credentials", "INVALID_CREDENTIALS", 401);
    }

    // Unified error message: disabled / no password / wrong password → same response
    if (user.status !== "active" || !user.passwordHash) {
      throw new AppError("Invalid credentials", "INVALID_CREDENTIALS", 401);
    }

    const { compare } = await import("bcryptjs");
    const passwordValid = await compare(data.password, user.passwordHash);
    if (!passwordValid) {
      throw new AppError("Invalid credentials", "INVALID_CREDENTIALS", 401);
    }

    const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);

    const accessToken = await signAccessToken({
      userId: user.id,
      username: user.username ?? "",
      userType: user.userType,
      tags,
      secret: jwtSecret,
      expiresInSec: accessExpiresIn,
      issuer: jwtIssuer,
    });

    const refreshToken = await signRefreshToken({
      userId: user.id,
      secret: jwtSecret,
      expiresInSec: refreshExpiresIn,
      issuer: jwtIssuer,
    });

    logger.info({ userId: user.id, username: user.username }, "User logged in");
    deps.eventBus.publish({ type: "user:logged_in", userId: user.id, username: user.username ?? "" });

    json(ctx.res, 200, {
      success: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: accessExpiresIn,
        token_type: "Bearer",
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          user_type: user.userType,
          tags,
        },
      },
    });
  });

  // POST /api/auth/refresh
  router.post("/api/auth/refresh", async (ctx) => {
    const data = await readJsonBody<{ refresh_token?: string }>(ctx.req);
    if (!data.refresh_token) {
      throw new AppError("refresh_token required", "BAD_REQUEST", 400);
    }

    let payload: JwtPayload;
    try {
      payload = await verifyJwt(data.refresh_token, jwtSecret, jwtIssuer);
    } catch (err) {
      logger.warn({ err }, "Refresh token verification failed");
      throw new AppError("Invalid or expired refresh token", "INVALID_REFRESH_TOKEN", 401);
    }

    if (payload.type !== "refresh") {
      throw new AppError("Invalid or expired refresh token", "INVALID_REFRESH_TOKEN", 401);
    }

    const user = await userRepo.findById(payload.sub);
    if (!user || user.status !== "active") {
      throw new AppError("User not found or disabled", "USER_DISABLED", 401);
    }

    const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);

    const accessToken = await signAccessToken({
      userId: user.id,
      username: user.username ?? "",
      userType: user.userType,
      tags,
      secret: jwtSecret,
      expiresInSec: accessExpiresIn,
      issuer: jwtIssuer,
    });

    json(ctx.res, 200, {
      success: true,
      data: {
        access_token: accessToken,
        expires_in: accessExpiresIn,
      },
    });
  });

  // POST /api/auth/change-password
  router.post("/api/auth/change-password", async (ctx) => {
    const token = extractBearerToken(ctx.req.headers.authorization);
    if (!token) {
      throw new AppError("Authentication required", "AUTH_REQUIRED", 401);
    }

    let payload: JwtPayload;
    try {
      payload = await verifyJwt(token, jwtSecret, jwtIssuer);
    } catch {
      throw new AppError("Authentication required", "AUTH_REQUIRED", 401);
    }

    const user = await userRepo.findById(payload.sub);
    if (!user || user.status !== "active") {
      throw new AppError("Authentication required", "AUTH_REQUIRED", 401);
    }

    const data = await readJsonBody<{ old_password?: string; new_password?: string }>(ctx.req);
    if (!data.old_password || !data.new_password) {
      throw new AppError("old_password and new_password required", "BAD_REQUEST", 400);
    }

    if (data.new_password.length < 8) {
      throw new AppError("Password must be at least 8 characters", "PASSWORD_TOO_SHORT", 400);
    }

    if (!user.passwordHash) {
      throw new AppError("Invalid current password", "INVALID_CURRENT_PASSWORD", 401);
    }

    const { compare, hashSync } = await import("bcryptjs");
    const valid = await compare(data.old_password, user.passwordHash);
    if (!valid) {
      throw new AppError("Invalid current password", "INVALID_CURRENT_PASSWORD", 401);
    }

    await userRepo.updatePassword(user.id, hashSync(data.new_password, 12));

    logger.info({ userId: user.id }, "Password changed");
    deps.eventBus.publish({ type: "user:password_changed", userId: user.id });

    json(ctx.res, 200, { success: true });
  });
}
