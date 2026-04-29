import { eq, and, like, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "../connection.js";
import { skills, skillFiles } from "../schema.js";
import type { SkillMeta, SkillMetaInput, SkillStatus, VersionBump } from "../../types/index.js";

function parseJson<T>(value: string | null): T {
  if (!value) return [] as unknown as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return [] as unknown as T;
  }
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export class SkillRepository {
  constructor(private db: DrizzleDB) {}

  async findById(id: string): Promise<SkillMeta | null> {
    const rows = this.db.select().from(skills).where(eq(skills.id, id)).limit(1).all();
    return rows.length > 0 ? this.toEntity(rows[0]) : null;
  }

  async findBySlug(slug: string): Promise<SkillMeta | null> {
    const rows = this.db.select().from(skills).where(eq(skills.slug, slug)).limit(1).all();
    return rows.length > 0 ? this.toEntity(rows[0]) : null;
  }

  async findByName(name: string): Promise<SkillMeta[]> {
    const rows = this.db.select().from(skills).where(eq(skills.name, name)).all();
    return rows.map(r => this.toEntity(r));
  }

  async findAll(options?: {
    status?: SkillStatus;
    category?: string;
    tags?: string[];
    visibility?: string;
    attributes?: Record<string, string>;
  }): Promise<SkillMeta[]> {
    const conditions: SQL[] = [];

    if (options?.status) conditions.push(eq(skills.status, options.status));
    if (options?.category) conditions.push(eq(skills.category, options.category));
    if (options?.visibility) conditions.push(eq(skills.visibility, options.visibility));
    if (options?.tags && options.tags.length > 0) {
      for (const tag of options.tags) {
        // Use parameterized pattern to prevent SQL injection
        const pattern = `%${tag}%`;
        conditions.push(sql`${skills.tags} LIKE ${pattern}`);
      }
    }
    if (options?.attributes) {
      for (const [key, value] of Object.entries(options.attributes)) {
        // Match JSON key-value: attributes contains "key":"value" or "key": "value"
        const pattern = `%${JSON.stringify(key)}":%${JSON.stringify(value)}%`;
        conditions.push(sql`${skills.attributes} LIKE ${pattern}`);
      }
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = this.db.select().from(skills).where(where).all();
    return rows.map(r => this.toEntity(r));
  }

  async create(input: SkillMetaInput): Promise<SkillMeta> {
    const now = Date.now();
    const id = randomUUID();

    this.db.insert(skills).values({
      id,
      slug: input.slug,
      name: input.name,
      displayName: input.displayName ?? null,
      description: input.description ?? "",
      version: input.version ?? "1.0.0",
      category: input.category ?? null,
      tags: toJson(input.tags ?? []),
      attributes: toJson(input.attributes ?? {}),
      status: input.status ?? "draft",
      visibility: input.visibility ?? "public",
      entryFile: input.entryFile ?? "SKILL.md",
      storagePath: input.storagePath ?? `${input.slug}/`,
      contentHash: input.contentHash ?? null,
      conditions: input.conditions ? toJson(input.conditions) : null,
      assignedGroups: toJson(input.assignedGroups ?? []),
      createdAt: now,
      updatedAt: now,
    }).run();

    return this.findById(id) as Promise<SkillMeta>;
  }

  async update(id: string, input: Partial<SkillMetaInput>): Promise<SkillMeta | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const updateData: Record<string, unknown> = { updatedAt: Date.now() };

    if (input.description !== undefined) updateData.description = input.description;
    if (input.displayName !== undefined) updateData.displayName = input.displayName;
    if (input.version !== undefined) updateData.version = input.version;
    if (input.category !== undefined) updateData.category = input.category;
    if (input.tags !== undefined) updateData.tags = toJson(input.tags);
    if (input.attributes !== undefined) updateData.attributes = toJson(input.attributes);
    if (input.status !== undefined) updateData.status = input.status;
    if (input.visibility !== undefined) updateData.visibility = input.visibility;
    if (input.entryFile !== undefined) updateData.entryFile = input.entryFile;
    if (input.storagePath !== undefined) updateData.storagePath = input.storagePath;
    if (input.contentHash !== undefined) updateData.contentHash = input.contentHash;
    if (input.conditions !== undefined) updateData.conditions = toJson(input.conditions);
    if (input.assignedGroups !== undefined) updateData.assignedGroups = toJson(input.assignedGroups);

    this.db.update(skills).set(updateData).where(eq(skills.id, id)).run();
    return this.findById(id);
  }

  async delete(slug: string): Promise<boolean> {
    const result = this.db.delete(skills).where(eq(skills.slug, slug)).run();
    return result.changes > 0;
  }

  async exists(slug: string): Promise<boolean> {
    const row = this.db.select({ id: skills.id })
      .from(skills)
      .where(eq(skills.slug, slug))
      .limit(1)
      .get();
    return !!row;
  }

  async count(): Promise<number> {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(skills).get();
    return row?.count ?? 0;
  }

  private toEntity(row: typeof skills.$inferSelect): SkillMeta {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      displayName: row.displayName,
      description: row.description,
      version: row.version,
      category: row.category,
      tags: parseJson<string[]>(row.tags),
      attributes: parseJson<Record<string, unknown>>(row.attributes),
      status: row.status as SkillStatus,
      visibility: row.visibility as SkillMeta["visibility"],
      entryFile: row.entryFile ?? "SKILL.md",
      storagePath: row.storagePath,
      contentHash: row.contentHash,
      conditions: parseJson<Record<string, unknown>>(row.conditions),
      assignedGroups: parseJson<string[]>(row.assignedGroups),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

export function bumpVersion(current: string, bump: VersionBump = "patch"): string {
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return "1.0.0";
  switch (bump) {
    case "major": return `${parts[0] + 1}.0.0`;
    case "minor": return `${parts[0]}.${parts[1] + 1}.0`;
    case "patch": return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
}
