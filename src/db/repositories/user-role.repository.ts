import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "../connection.js";
import { userRoles, roles } from "../schema.js";
import { getLogger } from "../../utils/logger.js";
import { metrics } from "../../telemetry/metrics.js";

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

  /**
   * T-503 — single-query batch lookup. Replaces N separate
   * findUserIdsByRoleId() calls in cache-subscriber when many roles match a
   * skill's tag set. Returns the de-duplicated set of user IDs across all
   * input role IDs.
   */
  async findUserIdsByRoleIds(roleIds: string[]): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const rows = this.db
      .selectDistinct({ userId: userRoles.userId })
      .from(userRoles)
      .where(inArray(userRoles.roleId, roleIds))
      .all();
    return rows.map(r => r.userId);
  }

  async getAggregatedTagsByUserId(userId: string): Promise<string[]> {
    const rows = this.db
      .select({ roleId: roles.id, tags: roles.tags })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId))
      .all();

    // T-714 — same defensive parse as RoleRepository.parseTags (T-712).
    // Aggregating tags at context-build time is the hot path for permission
    // checks; a corrupt row was previously discarded silently, which can
    // shrink a caller's tag set and (combined with `private` + empty-tags
    // fail-open semantics) silently widen visibility on adjacent skills.
    const logger = getLogger();
    const tagSet = new Set<string>();
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.tags);
      } catch (err) {
        logger.warn({ err, roleId: row.roleId, userId }, "Failed to parse role.tags JSON during aggregation; treating as empty");
        metrics.roleTagsParseErrors.inc();
        continue;
      }
      if (!Array.isArray(parsed)) {
        logger.warn({ roleId: row.roleId, userId }, "role.tags is not an array during aggregation; treating as empty");
        metrics.roleTagsParseErrors.inc();
        continue;
      }
      for (const t of parsed) {
        if (typeof t === "string") tagSet.add(t);
      }
    }
    return [...tagSet];
  }

  async replaceUserRoles(userId: string, roleIds: string[]): Promise<void> {
    const now = Date.now();
    // T-602 — dedupe defensively so the new UNIQUE(user_id, role_id) index
    // can never trip on a caller-side duplicate. The DB constraint stays as
    // the authoritative guard against concurrent duplicate assignments.
    const unique = [...new Set(roleIds)];
    this.db.transaction((tx) => {
      tx.delete(userRoles).where(eq(userRoles.userId, userId)).run();
      if (unique.length === 0) return;
      tx.insert(userRoles).values(
        unique.map(roleId => ({ id: randomUUID(), userId, roleId, createdAt: now })),
      ).run();
    });
  }

  async deleteByUserId(userId: string): Promise<void> {
    this.db.delete(userRoles).where(eq(userRoles.userId, userId)).run();
  }

  async deleteByRoleId(roleId: string): Promise<void> {
    this.db.delete(userRoles).where(eq(userRoles.roleId, roleId)).run();
  }
}
