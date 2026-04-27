import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "../connection.js";
import { skillFiles } from "../schema.js";

export class SkillFileRepository {
  constructor(private db: DrizzleDB) {}

  async create(skillId: string, file: {
    filePath: string;
    fileType: string;
    fileSize: number;
    mimeType: string;
    checksum?: string;
  }): Promise<void> {
    this.db.insert(skillFiles).values({
      id: randomUUID(),
      skillId,
      filePath: file.filePath,
      fileType: file.fileType,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
      checksum: file.checksum ?? null,
      createdAt: Date.now(),
    }).run();
  }

  async findBySkillId(skillId: string): Promise<Array<{
    filePath: string;
    fileType: string;
    fileSize: number;
    mimeType: string;
  }>> {
    return this.db.select({
      filePath: skillFiles.filePath,
      fileType: skillFiles.fileType,
      fileSize: skillFiles.fileSize,
      mimeType: skillFiles.mimeType,
    }).from(skillFiles).where(eq(skillFiles.skillId, skillId)).all();
  }

  async deleteBySkillId(skillId: string): Promise<void> {
    this.db.delete(skillFiles).where(eq(skillFiles.skillId, skillId)).run();
  }
}
