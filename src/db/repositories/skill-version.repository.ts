import { randomUUID } from "node:crypto";
import { skillVersions } from "../schema.js";
import { eq, and, desc } from "drizzle-orm";
import type { DrizzleDB } from "../connection.js";

export interface SkillVersion {
  id: string;
  skillId: string;
  version: string;
  contentHash: string;
  storagePath: string;
  entryFile: string;
  fileCount: number;
  createdBy: string | null;
  changeSummary: string | null;
  createdAt: number;
}

export interface CreateSkillVersionInput {
  skillId: string;
  version: string;
  contentHash: string;
  storagePath: string;
  entryFile?: string;
  fileCount: number;
  createdBy?: string;
  changeSummary?: string;
}

export class SkillVersionRepository {
  private db: DrizzleDB;

  constructor(database: DrizzleDB) {
    this.db = database;
  }

  create(input: CreateSkillVersionInput): SkillVersion {
    const id = randomUUID();
    const now = Date.now();

    this.db.insert(skillVersions).values({
      id,
      skillId: input.skillId,
      version: input.version,
      contentHash: input.contentHash,
      storagePath: input.storagePath,
      entryFile: input.entryFile ?? "SKILL.md",
      fileCount: input.fileCount,
      createdBy: input.createdBy ?? null,
      changeSummary: input.changeSummary ?? null,
      createdAt: now,
    }).run();

    return {
      id,
      skillId: input.skillId,
      version: input.version,
      contentHash: input.contentHash,
      storagePath: input.storagePath,
      entryFile: input.entryFile ?? "SKILL.md",
      fileCount: input.fileCount,
      createdBy: input.createdBy ?? null,
      changeSummary: input.changeSummary ?? null,
      createdAt: now,
    };
  }

  findBySkillId(skillId: string, limit?: number): SkillVersion[] {
    const query = this.db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
      .orderBy(desc(skillVersions.createdAt));

    const results = limit ? query.limit(limit).all() : query.all();
    return results as SkillVersion[];
  }

  findByVersion(skillId: string, version: string): SkillVersion | null {
    const result = this.db
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)))
      .limit(1)
      .all();

    return result.length > 0 ? (result[0] as SkillVersion) : null;
  }

  deleteOldVersions(skillId: string, keepCount: number): number {
    const versions = this.findBySkillId(skillId);
    if (versions.length <= keepCount) return 0;

    const toDelete = versions.slice(keepCount);
    let deleted = 0;
    for (const version of toDelete) {
      this.db.delete(skillVersions).where(eq(skillVersions.id, version.id)).run();
      deleted++;
    }
    return deleted;
  }

  count(skillId: string): number {
    const result = this.db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
      .all();
    return result.length;
  }
}
