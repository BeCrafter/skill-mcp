import { randomUUID, createHash } from "node:crypto";
import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { json, readJsonBody } from "../../helpers.js";
import { AppError } from "../../../utils/errors.js";

class UserNotFoundError extends AppError {
  constructor() { super("User not found", "USER_NOT_FOUND", 404); this.name = "UserNotFoundError"; }
}

export function registerAdminUserRoutes(router: Router, deps: AppDependencies): void {
  if (!deps.userRepo || !deps.roleRepo || !deps.userRoleRepo) return;
  const { userRepo, roleRepo, userRoleRepo, eventBus } = deps;

  router.get("/api/admin/users", async (ctx) => {
    const users = await userRepo.findAll();
    json(ctx.res, 200, { success: true, data: users });
  });

  router.post("/api/admin/users", async (ctx) => {
    const data = await readJsonBody<{ name?: string; role_ids?: string[] }>(ctx.req);
    const token = `sk-live-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const hash = createHash("sha256").update(token).digest("hex");
    const user = await userRepo.create({ name: data.name, token: hash });
    if (data.role_ids?.length) {
      await userRoleRepo.replaceUserRoles(user.id, data.role_ids);
    }
    const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);
    const roleIds = await userRoleRepo.findRoleIdsByUserId(user.id);
    const roleRows = await roleRepo.findByIds(roleIds);
    const roleNames = roleRows.map(r => r.name);
    json(ctx.res, 201, { success: true, data: { id: user.id, name: user.name, token, roles: roleNames, tags } });
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
