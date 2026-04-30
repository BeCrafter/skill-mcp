import { randomUUID, createHash } from "node:crypto";
import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { readBody, json } from "../../helpers.js";

export function registerAdminUserRoutes(router: Router, deps: AppDependencies): void {
  if (!deps.userRepo || !deps.roleRepo || !deps.userRoleRepo) return;
  const { userRepo, roleRepo, userRoleRepo, eventBus } = deps;

  router.get("/api/admin/users", async (ctx) => {
    const users = await userRepo.findAll();
    json(ctx.res, 200, { success: true, data: users });
  });

  router.post("/api/admin/users", async (ctx) => {
    const body = await readBody(ctx.req);
    let data: { name?: string; role_ids?: string[] };
    try { data = JSON.parse(body.toString()); } catch { json(ctx.res, 400, { success: false, error: "Invalid JSON" }); return; }
    const token = `sk-live-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const hash = createHash("sha256").update(token).digest("hex");
    const user = await userRepo.create({ name: data.name, token: hash });
    if (data.role_ids?.length) {
      await userRoleRepo.replaceUserRoles(user.id, data.role_ids);
    }
    const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);
    const roleIds = await userRoleRepo.findRoleIdsByUserId(user.id);
    const roleNames: string[] = [];
    for (const rid of roleIds) {
      const r = await roleRepo.findById(rid);
      if (r) roleNames.push(r.name);
    }
    json(ctx.res, 201, { success: true, data: { id: user.id, name: user.name, token, roles: roleNames, tags } });
  });

  router.get("/api/admin/users/:userId", async (ctx) => {
    const userId = ctx.params.userId;
    const user = await userRepo.findById(userId);
    if (!user) { json(ctx.res, 404, { success: false, error: "User not found" }); return; }
    const tags = await userRoleRepo.getAggregatedTagsByUserId(userId);
    const roleIds = await userRoleRepo.findRoleIdsByUserId(userId);
    const roles: Array<{ id: string; name: string; tags: string[] }> = [];
    for (const rid of roleIds) {
      const r = await roleRepo.findById(rid);
      if (r) roles.push({ id: r.id, name: r.name, tags: r.tags });
    }
    json(ctx.res, 200, { success: true, data: { ...user, roles, tags } });
  });

  router.put("/api/admin/users/:userId", async (ctx) => {
    const userId = ctx.params.userId;
    const body = await readBody(ctx.req);
    let data: { name?: string; status?: string };
    try { data = JSON.parse(body.toString()); } catch { json(ctx.res, 400, { success: false, error: "Invalid JSON" }); return; }
    const updated = await userRepo.update(userId, data);
    if (!updated) { json(ctx.res, 404, { success: false, error: "User not found" }); return; }
    json(ctx.res, 200, { success: true, data: updated });
  });

  router.delete("/api/admin/users/:userId", async (ctx) => {
    const userId = ctx.params.userId;
    await userRoleRepo.deleteByUserId(userId);
    const deleted = await userRepo.delete(userId);
    if (!deleted) { json(ctx.res, 404, { success: false, error: "User not found" }); return; }
    json(ctx.res, 200, { success: true });
  });

  router.put("/api/admin/users/:userId/roles", async (ctx) => {
    const userId = ctx.params.userId;
    const body = await readBody(ctx.req);
    let data: { role_ids: string[] };
    try { data = JSON.parse(body.toString()); } catch { json(ctx.res, 400, { success: false, error: "Invalid JSON" }); return; }
    const user = await userRepo.findById(userId);
    if (!user) { json(ctx.res, 404, { success: false, error: "User not found" }); return; }
    await userRoleRepo.replaceUserRoles(userId, data.role_ids ?? []);
    eventBus.publish({ type: "user:roles_changed", userId });
    json(ctx.res, 200, { success: true });
  });
}
