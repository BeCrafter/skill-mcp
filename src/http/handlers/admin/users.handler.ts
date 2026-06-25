import { createHash } from "node:crypto";
import { generateToken } from "../../../utils/id.js";
import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { json, readJsonBody } from "../../helpers.js";
import { AppError } from "../../../utils/errors.js";
import { TOKEN_ROTATION_GRACE_MS } from "../../../db/repositories/user.repository.js";
import { requireSuperadmin, assertSuperadminProtected } from "../../middleware/admin-auth.js";

class UserNotFoundError extends AppError {
  constructor() { super("User not found", "USER_NOT_FOUND", 404); this.name = "UserNotFoundError"; }
}

class InvalidExpiryError extends AppError {
  constructor(msg: string) { super(msg, "INVALID_EXPIRY", 400); this.name = "InvalidExpiryError"; }
}

function parseExpiry(input: { token_expires_at?: number | null; expires_in?: number | null }): number | null {
  if (input.token_expires_at != null) {
    if (typeof input.token_expires_at !== "number" || !Number.isFinite(input.token_expires_at) || input.token_expires_at <= Date.now()) {
      throw new InvalidExpiryError("token_expires_at must be a future epoch ms");
    }
    return Math.floor(input.token_expires_at);
  }
  if (input.expires_in != null) {
    if (typeof input.expires_in !== "number" || !Number.isFinite(input.expires_in) || input.expires_in <= 0) {
      throw new InvalidExpiryError("expires_in must be a positive number of seconds");
    }
    return Date.now() + Math.floor(input.expires_in * 1000);
  }
  return null;
}

export function registerAdminUserRoutes(router: Router, deps: AppDependencies): void {
  if (!deps.userRepo || !deps.roleRepo || !deps.userRoleRepo) return;
  const { userRepo, roleRepo, userRoleRepo, eventBus } = deps;

  router.get("/api/admin/users", async (ctx) => {
    const users = await userRepo.findAll();
    json(ctx.res, 200, { success: true, data: users });
  });

  router.post("/api/admin/users", async (ctx) => {
    const rc = ctx.requestContext!;
    const data = await readJsonBody<{ name?: string; role_ids?: string[]; token_expires_at?: number | null; expires_in?: number | null; user_type?: string; username?: string; password?: string }>(ctx.req);

    // user_type enum validation
    if (data.user_type && !["user", "admin"].includes(data.user_type)) {
      throw new AppError("Invalid user_type. Must be 'user' or 'admin'", "INVALID_USER_TYPE", 400);
    }

    // Only superadmin can create admin users
    if (data.user_type === "admin") {
      requireSuperadmin(rc);
    }

    // Password length validation
    if (data.password && data.password.length < 8) {
      throw new AppError("Password must be at least 8 characters", "PASSWORD_TOO_SHORT", 400);
    }

    const tokenExpiresAt = parseExpiry(data);
    const token = generateToken();
    const hash = createHash("sha256").update(token).digest("hex");

    let passwordHash: string | undefined;
    if (data.password) {
      const { hashSync } = await import("bcryptjs");
      passwordHash = hashSync(data.password, 12);
    }

    const user = await userRepo.create({
      name: data.name,
      username: data.username,
      passwordHash,
      userType: data.user_type ?? "user",
      token: hash,
      tokenExpiresAt,
    });

    // Auto-assign role matching user_type when no explicit roles provided
    const resolvedType = data.user_type ?? "user";
    if (!data.role_ids?.length) {
      const allRoles = await roleRepo.findAll();
      const matchingRole = allRoles.find(r => r.name === resolvedType);
      if (matchingRole) {
        await userRoleRepo.replaceUserRoles(user.id, [matchingRole.id]);
      }
    } else if (data.role_ids?.length) {
      await userRoleRepo.replaceUserRoles(user.id, data.role_ids);
    }

    const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);
    const roleIds = await userRoleRepo.findRoleIdsByUserId(user.id);
    const roleRows = await roleRepo.findByIds(roleIds);
    const roleNames = roleRows.map(r => r.name);
    json(ctx.res, 201, { success: true, data: { id: user.id, name: user.name, username: user.username, user_type: user.userType, token, token_expires_at: tokenExpiresAt, roles: roleNames, tags } });
  });

  router.post("/api/admin/users/:userId/rotate-token", async (ctx) => {
    const rc = ctx.requestContext!;
    const userId = ctx.params.userId;
    const target = await userRepo.findById(userId);
    if (!target) throw new UserNotFoundError();
    assertSuperadminProtected(target, rc.userId);

    type RotateBody = { token_expires_at?: number | null; expires_in?: number | null; grace_seconds?: number | null };
    const data = await readJsonBody<RotateBody>(ctx.req).catch(() => ({} as RotateBody));
    const tokenExpiresAt = parseExpiry(data);
    let graceMs = TOKEN_ROTATION_GRACE_MS;
    if (data.grace_seconds != null) {
      if (typeof data.grace_seconds !== "number" || !Number.isFinite(data.grace_seconds) || data.grace_seconds < 0) {
        throw new InvalidExpiryError("grace_seconds must be a non-negative number");
      }
      graceMs = Math.floor(data.grace_seconds * 1000);
    }
    const token = generateToken();
    const hash = createHash("sha256").update(token).digest("hex");
    const updated = await userRepo.rotateToken(userId, hash, { graceMs, tokenExpiresAt });
    if (!updated) throw new UserNotFoundError();
    json(ctx.res, 200, {
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        token,
        token_expires_at: updated.tokenExpiresAt,
        previous_token_expires_at: updated.previousTokenExpiresAt,
        grace_seconds: Math.floor(graceMs / 1000),
      },
    });
  });

  router.delete("/api/admin/users/:userId/previous-token", async (ctx) => {
    const rc = ctx.requestContext!;
    const userId = ctx.params.userId;
    const user = await userRepo.findById(userId);
    if (!user) throw new UserNotFoundError();
    assertSuperadminProtected(user, rc.userId);
    await userRepo.clearPreviousToken(userId);
    json(ctx.res, 200, { success: true });
  });

  router.get("/api/admin/users/:userId", async (ctx) => {
    const userId = ctx.params.userId;
    const user = await userRepo.findById(userId);
    if (!user) throw new UserNotFoundError();
    const tags = await userRoleRepo.getAggregatedTagsByUserId(userId);
    const roleIds = await userRoleRepo.findRoleIdsByUserId(userId);
    const roleRows = await roleRepo.findByIds(roleIds);
    const roles = roleRows.map(r => ({ id: r.id, name: r.name, tags: r.tags }));
    json(ctx.res, 200, { success: true, data: { ...user, roles, tags } });
  });

  router.put("/api/admin/users/:userId", async (ctx) => {
    const rc = ctx.requestContext!;
    requireSuperadmin(rc);
    const userId = ctx.params.userId;
    const data = await readJsonBody<{ name?: string; status?: string; user_type?: string }>(ctx.req);
    const target = await userRepo.findById(userId);
    if (!target) throw new UserNotFoundError();
    assertSuperadminProtected(target, rc.userId);

    const updateInput: { name?: string; status?: string; userType?: string } = {};
    if (data.name !== undefined) updateInput.name = data.name;
    if (data.status !== undefined) updateInput.status = data.status;

    // user_type change rules
    if (data.user_type !== undefined) {
      if (data.user_type === "superadmin") {
        throw new AppError("Cannot promote to superadmin via API", "FORBIDDEN_USER_TYPE", 403);
      }
      if (!["user", "admin"].includes(data.user_type)) {
        throw new AppError("Invalid user_type. Must be 'user' or 'admin'", "INVALID_USER_TYPE", 400);
      }
      // Only superadmin can change user_type
      requireSuperadmin(rc);
      updateInput.userType = data.user_type;
    }

    const updated = await userRepo.update(userId, updateInput);
    json(ctx.res, 200, { success: true, data: updated });
  });

  router.delete("/api/admin/users/:userId", async (ctx) => {
    const rc = ctx.requestContext!;
    requireSuperadmin(rc);
    const userId = ctx.params.userId;
    const target = await userRepo.findById(userId);
    if (!target) throw new UserNotFoundError();
    assertSuperadminProtected(target, rc.userId);
    await userRoleRepo.deleteByUserId(userId);
    const deleted = await userRepo.delete(userId);
    if (!deleted) throw new UserNotFoundError();
    json(ctx.res, 200, { success: true });
  });

  router.put("/api/admin/users/:userId/roles", async (ctx) => {
    const rc = ctx.requestContext!;
    requireSuperadmin(rc);
    const userId = ctx.params.userId;
    const data = await readJsonBody<{ role_ids?: string[] }>(ctx.req);
    const user = await userRepo.findById(userId);
    if (!user) throw new UserNotFoundError();
    assertSuperadminProtected(user, rc.userId);
    await userRoleRepo.replaceUserRoles(userId, data.role_ids ?? []);
    eventBus.publish({ type: "user:roles_changed", userId });
    json(ctx.res, 200, { success: true });
  });

  // Reset password endpoint — admin+ can reset, but only superadmin can reset superadmin
  router.post("/api/admin/users/:username/reset-password", async (ctx) => {
    const rc = ctx.requestContext!;
    const username = ctx.params.username;
    const data = await readJsonBody<{ new_password?: string }>(ctx.req);

    if (!data.new_password || data.new_password.length < 8) {
      throw new AppError("Password must be at least 8 characters", "PASSWORD_TOO_SHORT", 400);
    }

    const target = await userRepo.findByUsername(username);
    if (!target) throw new UserNotFoundError();

    // Only superadmin can reset another superadmin's password
    if (target.userType === "superadmin" && rc.userType !== "superadmin") {
      throw new AppError("Only superadmin can reset superadmin password", "SUPERADMIN_PROTECTED", 403);
    }

    const { hashSync } = await import("bcryptjs");
    await userRepo.updatePassword(target.id, hashSync(data.new_password, 12));
    json(ctx.res, 200, { success: true });
  });
}
