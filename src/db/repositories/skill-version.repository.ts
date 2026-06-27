import { generateId, generateUniqueId } from "../../utils/id.js";
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
  isCurrent: boolean;
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
  isCurrent?: boolean;
}

export class SkillVersionRepository {
  private db: DrizzleDB;

  constructor(database: DrizzleDB) {
    this.db = database;
  }

  async create(input: CreateSkillVersionInput): Promise<SkillVersion> {
    const id = await generateUniqueId(() => generateId("ver_"), async (id) => {
      const row = this.db.select({ id: skillVersions.id }).from(skillVersions).where(eq(skillVersions.id, id)).get();
      return !!row;
    });
    const now = Date.now();
    const isCurrent = input.isCurrent ?? true;

    // If marking as current, clear other current flags for this skill
    if (isCurrent) {
      this.db.update(skillVersions)
        .set({ isCurrent: false })
        .where(eq(skillVersions.skillId, input.skillId))
        .run();
    }

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
      isCurrent,
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
      isCurrent,
      createdAt: now,
    };
  }

  findCurrent(skillId: string): SkillVersion | null {
    const result = this.db
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.isCurrent, true)))
      .limit(1)
      .all();
    return result.length > 0 ? (result[0] as SkillVersion) : null;
  }

  markCurrent(skillId: string, versionId: string): void {
    this.db.update(skillVersions)
      .set({ isCurrent: false })
      .where(eq(skillVersions.skillId, skillId))
      .run();
    this.db.update(skillVersions)
      .set({ isCurrent: true })
      .where(eq(skillVersions.id, versionId))
      .run();
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
