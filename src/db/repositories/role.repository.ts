import { eq, inArray } from "drizzle-orm";
import { generateId, generateUniqueId } from "../../utils/id.js";
import type { DrizzleDB } from "../connection.js";
import { roles } from "../schema.js";
import { getLogger } from "../../utils/logger.js";
import { metrics } from "../../telemetry/metrics.js";
import { ConflictError } from "../../utils/errors.js";

export interface RoleEntity {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  createdAt: number | null;
  updatedAt: number | null;
}

export class RoleRepository {
  constructor(private db: DrizzleDB) {}

  async findById(id: string): Promise<RoleEntity | null> {
    const rows = this.db.select().from(roles).where(eq(roles.id, id)).limit(1).all();
    return rows.length > 0 ? this.toEntity(rows[0]) : null;
  }

  async findByName(name: string): Promise<RoleEntity | null> {
    const rows = this.db.select().from(roles).where(eq(roles.name, name)).limit(1).all();
    return rows.length > 0 ? this.toEntity(rows[0]) : null;
  }

  async findAll(): Promise<RoleEntity[]> {
    const rows = this.db.select().from(roles).all();
    return rows.map(r => this.toEntity(r));
  }

  /**
   * Bulk lookup by id, used to avoid N+1 fan-out from CLI/HTTP role listings.
   * Returns roles in the order they appear in the table; callers should index
   * the result by id rather than rely on ordering.
   */
  async findByIds(ids: readonly string[]): Promise<RoleEntity[]> {
    if (ids.length === 0) return [];
    const rows = this.db.select().from(roles).where(inArray(roles.id, ids as string[])).all();
    return rows.map(r => this.toEntity(r));
  }

  async create(input: { name: string; description?: string; tags: string[] }): Promise<RoleEntity> {
    const existing = await this.findByName(input.name);
    if (existing) throw new ConflictError(`Role "${input.name}" already exists`);
    const now = Date.now();
    const id = await generateUniqueId(() => generateId("role_"), async (id) => !!(await this.findById(id)));
    this.db.insert(roles).values({
      id,
      name: input.name,
      description: input.description ?? null,
      tags: JSON.stringify(input.tags),
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.findById(id) as Promise<RoleEntity>;
  }

  async update(id: string, input: { name?: string; description?: string; tags?: string[] }): Promise<RoleEntity | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    if (input.name !== undefined && input.name !== existing.name) {
      const conflict = await this.findByName(input.name);
      if (conflict) throw new ConflictError(`Role "${input.name}" already exists`);
    }
    const updateData: Record<string, unknown> = { updatedAt: Date.now() };
    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.tags !== undefined) updateData.tags = JSON.stringify(input.tags);
    this.db.update(roles).set(updateData).where(eq(roles.id, id)).run();
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.delete(roles).where(eq(roles.id, id)).run();
    return result.changes > 0;
  }

  private toEntity(row: typeof roles.$inferSelect): RoleEntity {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      tags: this.parseTags(row.tags, row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // T-712 — A corrupt tags column previously degraded silently to `[]`. For
  // `private` skills with empty tag lists, empty caller tags fail-open
  // (visible to any authenticated user), so silent corruption silently
  // widens visibility. We still return `[]` to avoid hard-failing role
  // lookups, but log + bump a counter so the corruption is observable.
  private parseTags(tagsStr: string, roleId: string): string[] {
    try {
      const parsed = JSON.parse(tagsStr);
      if (!Array.isArray(parsed)) {
        getLogger().warn({ roleId }, "role.tags is not an array; treating as empty");
        metrics.roleTagsParseErrors.inc();
        return [];
      }
      return parsed.filter((t): t is string => typeof t === "string");
    } catch (err) {
      getLogger().warn({ err, roleId }, "Failed to parse role.tags JSON; treating as empty");
      metrics.roleTagsParseErrors.inc();
      return [];
    }
  }
}
