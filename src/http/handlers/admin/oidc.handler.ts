import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { json, readJsonBody } from "../../helpers.js";
import { BadRequestError } from "../../../utils/errors.js";

interface MappingPutBody {
  groupName?: string;
  roleIds?: string[];
  tenantId?: string;
}

interface MappingCreateBody {
  groupName?: string;
  roleId?: string;
  tenantId?: string;
}

/**
 * P1-14 stage 3 — admin REST surface for OIDC group→role mapping +
 * provisioned identity audit. Mapping rows are read every time a verified
 * JWT lands; the surface lets operators flip an SSO group into the right
 * role(s) without manually touching every user. Routes:
 *
 *   GET    /api/admin/oidc/groups-mapping[?tenantId=]
 *      → list all `(group_name, role_id, ...)` rows for a tenant.
 *
 *   POST   /api/admin/oidc/groups-mapping
 *      Body: { groupName, roleId, tenantId? }
 *      → add one mapping row. UNIQUE(tenant, group, role) prevents dupes.
 *
 *   PUT    /api/admin/oidc/groups-mapping
 *      Body: { groupName, roleIds[], tenantId? }
 *      → atomically replace the role list for a (tenant, group) pair.
 *
 *   DELETE /api/admin/oidc/groups-mapping/:id
 *      → remove a single mapping row by ID.
 *
 *   GET    /api/admin/oidc/identities?userId=…
 *      → list `(issuer, subject, last_seen_at)` rows for a user (audit).
 */
export function registerAdminOidcRoutes(router: Router, deps: AppDependencies): void {
  if (!deps.oidcGroupRoleMapRepo || !deps.oidcIdentityRepo) return;
  const { oidcGroupRoleMapRepo, oidcIdentityRepo } = deps;

  router.get("/api/admin/oidc/groups-mapping", async (ctx) => {
    const tenantId = ctx.query.get("tenantId") ?? "default";
    const rows = await oidcGroupRoleMapRepo.findAllByTenant(tenantId);
    json(ctx.res, 200, { success: true, data: rows });
  });

  router.post("/api/admin/oidc/groups-mapping", async (ctx) => {
    const data = await readJsonBody<MappingCreateBody>(ctx.req);
    if (!data.groupName || typeof data.groupName !== "string") {
      throw new BadRequestError("groupName is required");
    }
    if (!data.roleId || typeof data.roleId !== "string") {
      throw new BadRequestError("roleId is required");
    }
    const tenantId = data.tenantId ?? "default";
    const created = await oidcGroupRoleMapRepo.create({
      tenantId,
      groupName: data.groupName,
      roleId: data.roleId,
    });
    json(ctx.res, 201, { success: true, data: created });
  });

  router.put("/api/admin/oidc/groups-mapping", async (ctx) => {
    const data = await readJsonBody<MappingPutBody>(ctx.req);
    if (!data.groupName || typeof data.groupName !== "string") {
      throw new BadRequestError("groupName is required");
    }
    if (!Array.isArray(data.roleIds)) {
      throw new BadRequestError("roleIds must be an array of role IDs");
    }
    const roleIds = data.roleIds.filter((r): r is string => typeof r === "string" && r.length > 0);
    const tenantId = data.tenantId ?? "default";
    await oidcGroupRoleMapRepo.replaceForGroup(tenantId, data.groupName, roleIds);
    const rows = await oidcGroupRoleMapRepo.findAllByTenant(tenantId);
    const filtered = rows.filter((r) => r.groupName === data.groupName);
    json(ctx.res, 200, { success: true, data: filtered });
  });

  router.delete("/api/admin/oidc/groups-mapping/:id", async (ctx) => {
    const id = ctx.params.id;
    const ok = await oidcGroupRoleMapRepo.deleteById(id);
    json(ctx.res, ok ? 200 : 404, { success: ok });
  });

  router.get("/api/admin/oidc/identities", async (ctx) => {
    const userId = ctx.query.get("userId");
    if (!userId) throw new BadRequestError("userId query param is required");
    const rows = await oidcIdentityRepo.findByUserId(userId);
    json(ctx.res, 200, { success: true, data: rows });
  });
}
