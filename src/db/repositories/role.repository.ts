import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "../connection.js";
import { roles } from "../schema.js";

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

  async create(input: { name: string; description?: string; tags: string[] }): Promise<RoleEntity> {
    const now = Date.now();
    const id = randomUUID();
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
      tags: this.parseTags(row.tags),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private parseTags(tagsStr: string): string[] {
    try {
      return JSON.parse(tagsStr);
    } catch {
      return [];
    }
  }
}
