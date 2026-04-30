import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "../connection.js";
import { userRoles, roles } from "../schema.js";

export class UserRoleRepository {
  constructor(private db: DrizzleDB) {}

  async findByUserId(userId: string): Promise<Array<{ userId: string; roleId: string }>> {
    const rows = this.db.select().from(userRoles).where(eq(userRoles.userId, userId)).all();
    return rows.map(r => ({ userId: r.userId, roleId: r.roleId }));
  }

  async findRoleIdsByUserId(userId: string): Promise<string[]> {
    const rows = this.db.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId)).all();
    return rows.map(r => r.roleId);
  }

  async findUserIdsByRoleId(roleId: string): Promise<string[]> {
    const rows = this.db.select({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.roleId, roleId)).all();
    return rows.map(r => r.userId);
  }

  async getAggregatedTagsByUserId(userId: string): Promise<string[]> {
    const rows = this.db
      .select({ tags: roles.tags })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId))
      .all();

    const tagSet = new Set<string>();
    for (const row of rows) {
      try {
        const parsed: string[] = JSON.parse(row.tags);
        parsed.forEach(t => tagSet.add(t));
      } catch {
        // skip invalid JSON
      }
    }
    return [...tagSet];
  }

  async replaceUserRoles(userId: string, roleIds: string[]): Promise<void> {
    this.db.delete(userRoles).where(eq(userRoles.userId, userId)).run();
    if (roleIds.length === 0) return;
    const now = Date.now();
    for (const roleId of roleIds) {
      this.db.insert(userRoles).values({
        id: randomUUID(),
        userId,
        roleId,
        createdAt: now,
      }).run();
    }
  }

  async deleteByUserId(userId: string): Promise<void> {
    this.db.delete(userRoles).where(eq(userRoles.userId, userId)).run();
  }

  async deleteByRoleId(roleId: string): Promise<void> {
    this.db.delete(userRoles).where(eq(userRoles.roleId, roleId)).run();
  }
}
