import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { json, readJsonBody } from "../../helpers.js";
import { AppError, BadRequestError } from "../../../utils/errors.js";
import { requireSuperadmin } from "../../middleware/admin-auth.js";

class RoleNotFoundError extends AppError {
  constructor() { super("Role not found", "ROLE_NOT_FOUND", 404); this.name = "RoleNotFoundError"; }
}

export function registerAdminRoleRoutes(router: Router, deps: AppDependencies): void {
  if (!deps.userRepo || !deps.roleRepo || !deps.userRoleRepo) return;
  const { roleRepo, userRoleRepo, eventBus } = deps;

  router.get("/api/admin/roles", async (ctx) => {
    const rolesList = await roleRepo.findAll();
    json(ctx.res, 200, { success: true, data: rolesList });
  });

  router.post("/api/admin/roles", async (ctx) => {
    requireSuperadmin(ctx.requestContext!);
    const data = await readJsonBody<{ name?: string; description?: string; tags?: string[] }>(ctx.req);
    if (!data.name || !Array.isArray(data.tags)) throw new BadRequestError("name and tags (array) required");
    const role = await roleRepo.create({ name: data.name, description: data.description, tags: data.tags });
    json(ctx.res, 201, { success: true, data: role });
  });

  router.get("/api/admin/roles/:roleId", async (ctx) => {
    const roleId = ctx.params.roleId;
    const role = await roleRepo.findById(roleId);
    if (!role) throw new RoleNotFoundError();
    json(ctx.res, 200, { success: true, data: role });
  });

  router.put("/api/admin/roles/:roleId", async (ctx) => {
    requireSuperadmin(ctx.requestContext!);
    const roleId = ctx.params.roleId;
    const data = await readJsonBody<{ name?: string; description?: string; tags?: string[] }>(ctx.req);
    if (data.tags !== undefined && !Array.isArray(data.tags)) {
      throw new BadRequestError("tags must be an array");
    }
    const updated = await roleRepo.update(roleId, data);
    if (!updated) throw new RoleNotFoundError();
    const affectedUserIds = await userRoleRepo.findUserIdsByRoleId(roleId);
    eventBus.publish({ type: "role:updated", roleId, affectedUserIds });
    json(ctx.res, 200, { success: true, data: updated });
  });

  router.delete("/api/admin/roles/:roleId", async (ctx) => {
    requireSuperadmin(ctx.requestContext!);
    const roleId = ctx.params.roleId;
    // T-731 — capture affected users *before* the cascade so we can publish
    // a `role:updated` event for them. Without this, every user assigned to
    // the deleted role keeps serving stale `skill:list:${userId}` cache
    // entries (with the old aggregated tag set) until TTL.
    const affectedUserIds = await userRoleRepo.findUserIdsByRoleId(roleId);
    if (userRoleRepo.deleteByRoleId) {
      await userRoleRepo.deleteByRoleId(roleId);
    }
    const deleted = await roleRepo.delete(roleId);
    if (!deleted) throw new RoleNotFoundError();
    eventBus.publish({ type: "role:updated", roleId, affectedUserIds });
    json(ctx.res, 200, { success: true });
  });
}
