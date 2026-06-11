import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "../connection.js";
import { oidcGroupRoleMap } from "../schema.js";
import { withSpan } from "../../telemetry/spans.js";

export interface OidcGroupRoleMapEntity {
  id: string;
  tenantId: string;
  groupName: string;
  roleId: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * P1-14 stage 3 — operator-managed mapping from JWT group claim values to
 * platform role IDs. Reading happens once per provisioning event (first
 * sight of a verified subject) so the table is small and read-heavy. The
 * UNIQUE constraint on `(tenant_id, group_name, role_id)` lets multiple
 * roles attach to the same group; the same role can also serve multiple
 * groups (a many-to-many).
 */
export class OidcGroupRoleMapRepository {
  constructor(private db: DrizzleDB) {}

  async findAllByTenant(tenantId: string): Promise<OidcGroupRoleMapEntity[]> {
    const rows = this.db
      .select()
      .from(oidcGroupRoleMap)
      .where(eq(oidcGroupRoleMap.tenantId, tenantId))
      .all();
    return rows.map((r) => this.toEntity(r));
  }

  async findRoleIdsByGroups(tenantId: string, groupNames: string[]): Promise<string[]> {
    if (groupNames.length === 0) return [];
    return withSpan(
      "db.query",
      { attributes: { "db.repo": "oidc_group_role_map", "db.method": "findRoleIdsByGroups" } },
      async () => {
        const rows = this.db
          .selectDistinct({ roleId: oidcGroupRoleMap.roleId })
          .from(oidcGroupRoleMap)
          .where(
            and(
              eq(oidcGroupRoleMap.tenantId, tenantId),
              inArray(oidcGroupRoleMap.groupName, groupNames),
            ),
          )
          .all();
        return rows.map((r) => r.roleId);
      },
    );
  }

  /**
   * Replace the role list for a single `(tenant, group)` pair. Useful for
   * the admin REST surface: PUT /api/v1/admin/oidc/groups-mapping/:group.
   * Atomic — concurrent writers see either the full old set or the full
   * new set, never a partial overlap.
   */
  async replaceForGroup(tenantId: string, groupName: string, roleIds: string[]): Promise<void> {
    const now = Date.now();
    const unique = [...new Set(roleIds)];
    this.db.transaction((tx) => {
      tx.delete(oidcGroupRoleMap)
        .where(
          and(
            eq(oidcGroupRoleMap.tenantId, tenantId),
            eq(oidcGroupRoleMap.groupName, groupName),
          ),
        )
        .run();
      if (unique.length === 0) return;
      tx.insert(oidcGroupRoleMap)
        .values(
          unique.map((roleId) => ({
            id: randomUUID(),
            tenantId,
            groupName,
            roleId,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .run();
    });
  }

  async deleteByGroup(tenantId: string, groupName: string): Promise<number> {
    const result = this.db
      .delete(oidcGroupRoleMap)
      .where(
        and(
          eq(oidcGroupRoleMap.tenantId, tenantId),
          eq(oidcGroupRoleMap.groupName, groupName),
        ),
      )
      .run();
    return result.changes;
  }

  async deleteById(id: string): Promise<boolean> {
    const result = this.db.delete(oidcGroupRoleMap).where(eq(oidcGroupRoleMap.id, id)).run();
    return result.changes > 0;
  }

  async create(input: {
    tenantId: string;
    groupName: string;
    roleId: string;
  }): Promise<OidcGroupRoleMapEntity> {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .insert(oidcGroupRoleMap)
      .values({
        id,
        tenantId: input.tenantId,
        groupName: input.groupName,
        roleId: input.roleId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return {
      id,
      tenantId: input.tenantId,
      groupName: input.groupName,
      roleId: input.roleId,
      createdAt: now,
      updatedAt: now,
    };
  }

  private toEntity(row: typeof oidcGroupRoleMap.$inferSelect): OidcGroupRoleMapEntity {
    return {
      id: row.id,
      tenantId: row.tenantId ?? "default",
      groupName: row.groupName,
      roleId: row.roleId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
