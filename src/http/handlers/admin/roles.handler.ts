import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { readBody, json } from "../../helpers.js";

export function registerAdminRoleRoutes(router: Router, deps: AppDependencies): void {
  if (!deps.userRepo || !deps.roleRepo || !deps.userRoleRepo) return;
  const { roleRepo, userRoleRepo, eventBus } = deps;

  router.get("/api/admin/roles", async (ctx) => {
    const rolesList = await roleRepo.findAll();
    json(ctx.res, 200, { success: true, data: rolesList });
  });

  router.post("/api/admin/roles", async (ctx) => {
    const body = await readBody(ctx.req);
    let data: { name: string; description?: string; tags: string[] };
    try { data = JSON.parse(body.toString()); } catch { json(ctx.res, 400, { success: false, error: "Invalid JSON" }); return; }
    if (!data.name || !data.tags) { json(ctx.res, 400, { success: false, error: "name and tags required" }); return; }
    const role = await roleRepo.create(data);
    json(ctx.res, 201, { success: true, data: role });
  });

  router.get("/api/admin/roles/:roleId", async (ctx) => {
    const roleId = ctx.params.roleId;
    const role = await roleRepo.findById(roleId);
    if (!role) { json(ctx.res, 404, { success: false, error: "Role not found" }); return; }
    json(ctx.res, 200, { success: true, data: role });
  });

  router.put("/api/admin/roles/:roleId", async (ctx) => {
    const roleId = ctx.params.roleId;
    const body = await readBody(ctx.req);
    let data: { name?: string; description?: string; tags?: string[] };
    try { data = JSON.parse(body.toString()); } catch { json(ctx.res, 400, { success: false, error: "Invalid JSON" }); return; }
    const updated = await roleRepo.update(roleId, data);
    if (!updated) { json(ctx.res, 404, { success: false, error: "Role not found" }); return; }
    const affectedUserIds = await userRoleRepo.findUserIdsByRoleId(roleId);
    eventBus.publish({ type: "role:updated", roleId, affectedUserIds });
    json(ctx.res, 200, { success: true, data: updated });
  });

  router.delete("/api/admin/roles/:roleId", async (ctx) => {
    const roleId = ctx.params.roleId;
    if (userRoleRepo.deleteByRoleId) {
      await userRoleRepo.deleteByRoleId(roleId);
    }
    const deleted = await roleRepo.delete(roleId);
    if (!deleted) { json(ctx.res, 404, { success: false, error: "Role not found" }); return; }
    json(ctx.res, 200, { success: true });
  });
}
