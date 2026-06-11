import { eq } from "drizzle-orm";
import type { DrizzleDB } from "../connection.js";
import { skillEmbeddings } from "../schema.js";

/**
 * P1-11 stage 3 — round-trip embedding vectors as the underlying
 * Float32Array buffer. SQLite's BLOB column gives us back a Buffer; we
 * wrap it as a Float32Array view (zero-copy) on read and serialize from
 * the Float32Array's buffer on write.
 *
 * Failure modes worth noting:
 *  - Buffer length mismatched against `dimension * 4` would mean the row
 *    was written with a different-precision encoding (e.g. float64). We
 *    raise so the caller treats the row as corrupt and triggers a
 *    re-embedding rather than silently using a misaligned vector.
 *  - Drizzle BLOB columns hand back Node `Buffer` instances; the byteOffset
 *    isn't always zero for sub-buffers, so we slice through `.buffer` with
 *    explicit offset/length.
 */

export interface SkillEmbeddingRow {
  skillId: string;
  modelName: string;
  dimension: number;
  vector: Float32Array;
  contentHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export class SkillEmbeddingRepository {
  constructor(private db: DrizzleDB) {}

  upsert(row: {
    skillId: string;
    modelName: string;
    dimension: number;
    vector: Float32Array;
    contentHash?: string | null;
  }): void {
    if (row.vector.length !== row.dimension) {
      throw new Error(
        `SkillEmbeddingRepository.upsert: vector length ${row.vector.length} != dimension ${row.dimension}`,
      );
    }
    const now = Date.now();
    const buffer = Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
    this.db
      .insert(skillEmbeddings)
      .values({
        skillId: row.skillId,
        modelName: row.modelName,
        dimension: row.dimension,
        vector: buffer,
        contentHash: row.contentHash ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: skillEmbeddings.skillId,
        set: {
          modelName: row.modelName,
          dimension: row.dimension,
          vector: buffer,
          contentHash: row.contentHash ?? null,
          updatedAt: now,
        },
      })
      .run();
  }

  findBySkillId(skillId: string): SkillEmbeddingRow | null {
    const row = this.db
      .select()
      .from(skillEmbeddings)
      .where(eq(skillEmbeddings.skillId, skillId))
      .get();
    if (!row) return null;
    return this.toEntity(row);
  }

  findAll(): SkillEmbeddingRow[] {
    const rows = this.db.select().from(skillEmbeddings).all();
    return rows.map((r) => this.toEntity(r));
  }

  delete(skillId: string): void {
    this.db.delete(skillEmbeddings).where(eq(skillEmbeddings.skillId, skillId)).run();
  }

  /** Used by the model-swap path: drop every row that wasn't written by
   *  the current model so the search service can repopulate them with the
   *  new dimension. Returns the count of removed rows for observability. */
  deleteWhereModelNot(modelName: string): number {
    const allRows = this.db.select({ skillId: skillEmbeddings.skillId, modelName: skillEmbeddings.modelName }).from(skillEmbeddings).all();
    let count = 0;
    for (const r of allRows) {
      if (r.modelName !== modelName) {
        this.db.delete(skillEmbeddings).where(eq(skillEmbeddings.skillId, r.skillId)).run();
        count += 1;
      }
    }
    return count;
  }

  private toEntity(row: typeof skillEmbeddings.$inferSelect): SkillEmbeddingRow {
    const buf = row.vector as unknown as Buffer;
    if (buf.byteLength !== row.dimension * 4) {
      throw new Error(
        `SkillEmbeddingRepository: corrupt row skill_id=${row.skillId} (buffer ${buf.byteLength}B, expected ${row.dimension * 4}B)`,
      );
    }
    // Float32Array view over the Buffer's underlying ArrayBuffer. Slice
    // through .buffer + byteOffset so partial-buffer cases (Buffer.from()
    // sometimes hands back a sub-view of a pool buffer) decode correctly.
    const vector = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    return {
      skillId: row.skillId,
      modelName: row.modelName,
      dimension: row.dimension,
      vector,
      contentHash: row.contentHash ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
