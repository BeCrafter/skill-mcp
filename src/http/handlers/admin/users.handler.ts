import { createHash } from "node:crypto";
import { generateToken } from "../../../utils/id.js";
import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { json, readJsonBody } from "../../helpers.js";
import { AppError } from "../../../utils/errors.js";
import { TOKEN_ROTATION_GRACE_MS } from "../../../db/repositories/user.repository.js";
import { requireSuperadmin } from "../../middleware/admin-auth.js";

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

const PRIVILEGED_ROLE_NAMES = new Set(["superadmin", "admin"]);

/** Check if caller can operate on target. Superadmin targets are protected from other superadmins, but can operate on themselves. */
function assertCanOperateOn(target: { userType: string; id: string }, operatorId: string, operatorUserType?: string): void {
  if (target.userType === "superadmin") {
    // 超管之间互相保护，但允许操作自己
    if (target.id === operatorId) return;
    throw new AppError("Cannot operate on superadmin user", "SUPERADMIN_PROTECTED", 403);
  }
  if (target.userType === "admin" && operatorUserType !== "superadmin") {
    // admin 操作 admin 需要 superadmin 权限，但允许操作自己
    if (target.id === operatorId) return;
    throw new AppError("Only superadmin can operate on admin users", "SUPERADMIN_REQUIRED", 403);
  }
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
    if (data.user_type && !["user", "admin", "superadmin"].includes(data.user_type)) {
      throw new AppError("Invalid user_type. Must be 'user', 'admin', or 'superadmin'", "INVALID_USER_TYPE", 400);
    }

    // Only superadmin can create admin/superadmin users
    if (data.user_type === "admin" || data.user_type === "superadmin") {
      requireSuperadmin(rc);
    }

    // role_ids containing privileged roles also requires superadmin
    if (data.role_ids?.length) {
      const roles = await roleRepo.findByIds(data.role_ids);
      const hasPrivilegedRole = roles.some(r => PRIVILEGED_ROLE_NAMES.has(r.name));
      if (hasPrivilegedRole) requireSuperadmin(rc);
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
      tokenPlaintext: token,
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
    assertCanOperateOn(target, rc.userId, rc.userType);

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
    const updated = await userRepo.rotateToken(userId, hash, { graceMs, tokenExpiresAt, tokenPlaintext: token });
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
    assertCanOperateOn(user, rc.userId, rc.userType);
    await userRepo.clearPreviousToken(userId);
    json(ctx.res, 200, { success: true });
  });

  router.get("/api/admin/users/:userId", async (ctx) => {
    const rc = ctx.requestContext!;
    const userId = ctx.params.userId;
    const user = await userRepo.findById(userId);
    if (!user) throw new UserNotFoundError();
    const tags = await userRoleRepo.getAggregatedTagsByUserId(userId);
    const roleIds = await userRoleRepo.findRoleIdsByUserId(userId);
    const roleRows = await roleRepo.findByIds(roleIds);
    const roles = roleRows.map(r => ({ id: r.id, name: r.name, tags: r.tags }));

    // Only include token_plaintext if caller has permission to operate on this user
    let tokenPlaintext: string | undefined;
    try {
      assertCanOperateOn(user, rc.userId, rc.userType);
      tokenPlaintext = user.tokenPlaintext ?? undefined;
    } catch {
      // No permission - don't include token
    }

    json(ctx.res, 200, { success: true, data: { ...user, roles, tags, token_plaintext: tokenPlaintext } });
  });

  router.put("/api/admin/users/:userId", async (ctx) => {
    const rc = ctx.requestContext!;
    const userId = ctx.params.userId;
    const data = await readJsonBody<{ name?: string; status?: string; user_type?: string }>(ctx.req);
    const target = await userRepo.findById(userId);
    if (!target) throw new UserNotFoundError();
    assertCanOperateOn(target, rc.userId, rc.userType);

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
      requireSuperadmin(rc);
      updateInput.userType = data.user_type;
    }

    const updated = await userRepo.update(userId, updateInput);
    json(ctx.res, 200, { success: true, data: updated });
  });

  router.delete("/api/admin/users/:userId", async (ctx) => {
    const rc = ctx.requestContext!;
    const userId = ctx.params.userId;
    const target = await userRepo.findById(userId);
    if (!target) throw new UserNotFoundError();
    assertCanOperateOn(target, rc.userId, rc.userType);
    await userRoleRepo.deleteByUserId(userId);
    const deleted = await userRepo.delete(userId);
    if (!deleted) throw new UserNotFoundError();
    json(ctx.res, 200, { success: true });
  });

  router.put("/api/admin/users/:userId/roles", async (ctx) => {
    const rc = ctx.requestContext!;
    const userId = ctx.params.userId;
    const data = await readJsonBody<{ role_ids?: string[] }>(ctx.req);
    const user = await userRepo.findById(userId);
    if (!user) throw new UserNotFoundError();
    assertCanOperateOn(user, rc.userId, rc.userType);

    // Check if privileged roles are being assigned
    if (data.role_ids?.length) {
      const roles = await roleRepo.findByIds(data.role_ids);
      const hasPrivilegedRole = roles.some(r => PRIVILEGED_ROLE_NAMES.has(r.name));
      if (hasPrivilegedRole) requireSuperadmin(rc);
    }

    await userRoleRepo.replaceUserRoles(userId, data.role_ids ?? []);
    eventBus.publish({ type: "user:roles_changed", userId });
    json(ctx.res, 200, { success: true });
  });

  // Reset password — admin can only reset own; superadmin can reset any admin
  router.post("/api/admin/users/:username/reset-password", async (ctx) => {
    const rc = ctx.requestContext!;
    const username = ctx.params.username;
    const data = await readJsonBody<{ new_password?: string }>(ctx.req);

    if (!data.new_password || data.new_password.length < 8) {
      throw new AppError("Password must be at least 8 characters", "PASSWORD_TOO_SHORT", 400);
    }

    const target = await userRepo.findByUsername(username);
    if (!target) throw new UserNotFoundError();

    // Superadmin target: only self can reset
    if (target.userType === "superadmin" && target.id !== rc.userId) {
      throw new AppError("Cannot reset another superadmin's password", "SUPERADMIN_PROTECTED", 403);
    }
    // Admin target: only superadmin can reset
    if (target.userType === "admin" && rc.userType !== "superadmin") {
      throw new AppError("Only superadmin can reset admin password", "SUPERADMIN_REQUIRED", 403);
    }
    // Non-admin target (shouldn't have password, but guard anyway)
    if (target.userType !== "superadmin" && target.userType !== "admin" && target.id !== rc.userId) {
      throw new AppError("Cannot reset this user's password", "FORBIDDEN", 403);
    }

    const { hashSync } = await import("bcryptjs");
    await userRepo.updatePassword(target.id, hashSync(data.new_password, 12));
    json(ctx.res, 200, { success: true });
  });
}
