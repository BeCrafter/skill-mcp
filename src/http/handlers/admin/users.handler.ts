import { createHash } from "node:crypto";
import { generateToken } from "../../../utils/id.js";
import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { json, readJsonBody } from "../../helpers.js";
import { AppError } from "../../../utils/errors.js";
import { TOKEN_ROTATION_GRACE_MS } from "../../../db/repositories/user.repository.js";

class UserNotFoundError extends AppError {
  constructor() { super("User not found", "USER_NOT_FOUND", 404); this.name = "UserNotFoundError"; }
}

class InvalidExpiryError extends AppError {
  constructor(msg: string) { super(msg, "INVALID_EXPIRY", 400); this.name = "InvalidExpiryError"; }
}

// P0-4 — accept either an absolute epoch ms (`token_expires_at`) or a relative
// duration in seconds (`expires_in`). Returns null when neither is supplied
// (token never expires) or throws InvalidExpiryError on malformed inputs.
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
    const data = await readJsonBody<{ name?: string; role_ids?: string[]; token_expires_at?: number | null; expires_in?: number | null }>(ctx.req);
    const tokenExpiresAt = parseExpiry(data);
    const token = generateToken();
    const hash = createHash("sha256").update(token).digest("hex");
    const user = await userRepo.create({ name: data.name, token: hash, tokenExpiresAt });
    if (data.role_ids?.length) {
      await userRoleRepo.replaceUserRoles(user.id, data.role_ids);
    }
    const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);
    const roleIds = await userRoleRepo.findRoleIdsByUserId(user.id);
    const roleRows = await roleRepo.findByIds(roleIds);
    const roleNames = roleRows.map(r => r.name);
    json(ctx.res, 201, { success: true, data: { id: user.id, name: user.name, token, token_expires_at: tokenExpiresAt, roles: roleNames, tags } });
  });

  // P0-4 — rotate-token endpoint. Mints a fresh plaintext token, atomically
  // moves the previous token into the grace slot (default 7 days), and
  // returns both the new token and the grace expiry so callers can plan a
  // staged client rollout. Returns 404 if the user does not exist; 400 if
  // expires_in / token_expires_at / grace_seconds are malformed.
  router.post("/api/admin/users/:userId/rotate-token", async (ctx) => {
    const userId = ctx.params.userId;
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

  // P0-4 — explicit revocation of the previous-token grace slot. Use this
  // ahead of the natural grace expiry when responding to a credential
  // compromise. Idempotent: returns 200 even if no grace slot was set.
  router.delete("/api/admin/users/:userId/previous-token", async (ctx) => {
    const userId = ctx.params.userId;
    const user = await userRepo.findById(userId);
    if (!user) throw new UserNotFoundError();
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
    const userId = ctx.params.userId;
    const data = await readJsonBody<{ name?: string; status?: string }>(ctx.req);
    const updated = await userRepo.update(userId, data);
    if (!updated) throw new UserNotFoundError();
    json(ctx.res, 200, { success: true, data: updated });
  });

  router.delete("/api/admin/users/:userId", async (ctx) => {
    const userId = ctx.params.userId;
    await userRoleRepo.deleteByUserId(userId);
    const deleted = await userRepo.delete(userId);
    if (!deleted) throw new UserNotFoundError();
    json(ctx.res, 200, { success: true });
  });

  router.put("/api/admin/users/:userId/roles", async (ctx) => {
    const userId = ctx.params.userId;
    const data = await readJsonBody<{ role_ids?: string[] }>(ctx.req);
    const user = await userRepo.findById(userId);
    if (!user) throw new UserNotFoundError();
    await userRoleRepo.replaceUserRoles(userId, data.role_ids ?? []);
    eventBus.publish({ type: "user:roles_changed", userId });
    json(ctx.res, 200, { success: true });
  });
}
