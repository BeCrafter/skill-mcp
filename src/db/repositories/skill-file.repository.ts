import { eq } from "drizzle-orm";
import { shortId, generateUniqueId } from "../../utils/id.js";
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
    const id = await generateUniqueId(() => shortId(), async (id) => {
      const row = this.db.select({ id: skillFiles.id }).from(skillFiles).where(eq(skillFiles.id, id)).get();
      return !!row;
    });
    this.db.insert(skillFiles).values({
      id,
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

  /**
   * Atomically replace the file rows for a skill in a single DB transaction.
   * On any failure the previous rows remain intact (transaction rolls back).
   */
  async replaceAll(skillId: string, files: Array<{
    filePath: string;
    fileType: string;
    fileSize: number;
    mimeType: string;
    checksum?: string;
  }>): Promise<void> {
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.delete(skillFiles).where(eq(skillFiles.skillId, skillId)).run();
      if (files.length === 0) return;
      tx.insert(skillFiles).values(files.map(f => ({
        id: shortId(),
        skillId,
        filePath: f.filePath,
        fileType: f.fileType,
        fileSize: f.fileSize,
        mimeType: f.mimeType,
        checksum: f.checksum ?? null,
        createdAt: now,
      }))).run();
    });
  }
}
