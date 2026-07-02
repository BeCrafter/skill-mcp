import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { SkillEmbeddingRepository } from "../../../src/db/repositories/skill-embedding.repository.js";
import { SkillRepository } from "../../../src/db/repositories/skill.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

interface RawSqlite {
  prepare(sql: string): { run: (...params: unknown[]) => unknown };
}

/**
 * P1-11 stage 3 — SkillEmbeddingRepository contract. Pins:
 *   - Float32Array round-trip via SQLite BLOB (Buffer wraps + slice through
 *     .buffer + byteOffset to handle Node's pooled sub-buffers).
 *   - upsert replaces the row on conflict (PK = skill_id).
 *   - vector.length must match dimension at write time (early caller-side error
 *     beats a mid-search corrupt vector).
 *   - corrupt row (buffer length ≠ dimension*4) raises on read so the search
 *     service can drop + re-embed instead of silently using bad vectors.
 *   - deleteWhereModelNot drops only stale-model rows (post model swap path).
 *   - ON DELETE CASCADE: removing the parent skill removes its embedding row.
 */

function createTestTables(db: DrizzleDB): void {
  const statements = [
    `CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      display_name TEXT, description TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '0.0.1', category TEXT DEFAULT NULL,
      attributes TEXT, retrieval_meta TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      visibility TEXT NOT NULL DEFAULT 'private', entry_file TEXT DEFAULT 'SKILL.md',
      storage_path TEXT NOT NULL, content_hash TEXT,
      import_source TEXT, import_url TEXT, import_branch TEXT, import_sub_dir TEXT, imported_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS skill_tags (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (skill_id, tag)
    )`,
    `CREATE TABLE IF NOT EXISTS skill_embeddings (
      skill_id TEXT PRIMARY KEY NOT NULL,
      model_name TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      vector BLOB NOT NULL,
      content_hash TEXT,
      import_source TEXT, import_url TEXT, import_branch TEXT, import_sub_dir TEXT, imported_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_skill_embeddings_model ON skill_embeddings(model_name)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_slug ON skills(slug)`,
  ];
  for (const sql of statements) {
    db.run(sql);
  }
}

function vec(values: number[]): Float32Array {
  return new Float32Array(values);
}

describe("SkillEmbeddingRepository", () => {
  let db: DrizzleDB;
  let rawSqlite: RawSqlite;
  let repo: SkillEmbeddingRepository;
  let skillRepo: SkillRepository;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    rawSqlite = sqlite as unknown as RawSqlite;
    db = drizzle(sqlite, { schema });
    createTestTables(db);
    repo = new SkillEmbeddingRepository(db);
    skillRepo = new SkillRepository(db);
  });

  async function makeSkill(slug: string): Promise<string> {
    const s = await skillRepo.create({
      slug,
      name: slug,
      description: "x",
      storagePath: `skills/${slug}/`,
      status: "published",
    });
    return s.id;
  }

  describe("upsert + findBySkillId round-trip", () => {
    it("round-trips a Float32Array through SQLite BLOB", async () => {
      const id = await makeSkill("alpha");
      const v = vec([0.1, -0.2, 0.3, 0.4]);
      repo.upsert({
        skillId: id,
        modelName: "test-model",
        dimension: 4,
        vector: v,
        contentHash: "h1",
      });

      const got = repo.findBySkillId(id);
      expect(got).not.toBeNull();
      expect(got!.skillId).toBe(id);
      expect(got!.modelName).toBe("test-model");
      expect(got!.dimension).toBe(4);
      expect(got!.contentHash).toBe("h1");
      expect(got!.vector).toBeInstanceOf(Float32Array);
      expect(got!.vector.length).toBe(4);
      // Float32 → exact equality, not toBeCloseTo
      expect(got!.vector[0]).toBeCloseTo(0.1, 5);
      expect(got!.vector[1]).toBeCloseTo(-0.2, 5);
      expect(got!.vector[2]).toBeCloseTo(0.3, 5);
      expect(got!.vector[3]).toBeCloseTo(0.4, 5);
    });

    it("returns null for unknown skill", () => {
      expect(repo.findBySkillId("nope")).toBeNull();
    });

    it("upsert replaces the existing row on conflict", async () => {
      const id = await makeSkill("alpha");
      repo.upsert({ skillId: id, modelName: "m1", dimension: 3, vector: vec([1, 0, 0]), contentHash: "h1" });
      repo.upsert({ skillId: id, modelName: "m2", dimension: 3, vector: vec([0, 1, 0]), contentHash: "h2" });

      const got = repo.findBySkillId(id);
      expect(got!.modelName).toBe("m2");
      expect(got!.contentHash).toBe("h2");
      expect(got!.vector[1]).toBeCloseTo(1, 5);

      // Only one row total
      expect(repo.findAll().length).toBe(1);
    });

    it("contentHash defaults to null when omitted", async () => {
      const id = await makeSkill("alpha");
      repo.upsert({ skillId: id, modelName: "m", dimension: 2, vector: vec([0.5, 0.5]) });
      const got = repo.findBySkillId(id);
      expect(got!.contentHash).toBeNull();
    });

    it("rejects upsert when vector.length != dimension", async () => {
      const id = await makeSkill("alpha");
      expect(() =>
        repo.upsert({ skillId: id, modelName: "m", dimension: 4, vector: vec([1, 0, 0]) }),
      ).toThrow(/vector length 3 != dimension 4/);
    });
  });

  describe("findAll", () => {
    it("returns all rows", async () => {
      const a = await makeSkill("alpha");
      const b = await makeSkill("beta");
      repo.upsert({ skillId: a, modelName: "m", dimension: 2, vector: vec([1, 0]) });
      repo.upsert({ skillId: b, modelName: "m", dimension: 2, vector: vec([0, 1]) });

      const all = repo.findAll();
      expect(all.length).toBe(2);
      expect(all.map((r) => r.skillId).sort()).toEqual([a, b].sort());
    });

    it("returns empty when no rows", () => {
      expect(repo.findAll()).toEqual([]);
    });
  });

  describe("delete", () => {
    it("deletes a row by skillId", async () => {
      const id = await makeSkill("alpha");
      repo.upsert({ skillId: id, modelName: "m", dimension: 2, vector: vec([1, 0]) });
      repo.delete(id);
      expect(repo.findBySkillId(id)).toBeNull();
    });

    it("delete on unknown id is a no-op", () => {
      expect(() => repo.delete("nope")).not.toThrow();
    });
  });

  describe("deleteWhereModelNot", () => {
    it("drops only stale-model rows", async () => {
      const a = await makeSkill("alpha");
      const b = await makeSkill("beta");
      const c = await makeSkill("gamma");
      repo.upsert({ skillId: a, modelName: "old-model", dimension: 2, vector: vec([1, 0]) });
      repo.upsert({ skillId: b, modelName: "new-model", dimension: 2, vector: vec([0, 1]) });
      repo.upsert({ skillId: c, modelName: "old-model", dimension: 2, vector: vec([1, 1]) });

      const dropped = repo.deleteWhereModelNot("new-model");
      expect(dropped).toBe(2);

      expect(repo.findBySkillId(a)).toBeNull();
      expect(repo.findBySkillId(b)).not.toBeNull();
      expect(repo.findBySkillId(c)).toBeNull();
    });

    it("returns 0 when all rows match the current model", async () => {
      const a = await makeSkill("alpha");
      repo.upsert({ skillId: a, modelName: "m", dimension: 2, vector: vec([1, 0]) });
      expect(repo.deleteWhereModelNot("m")).toBe(0);
      expect(repo.findBySkillId(a)).not.toBeNull();
    });

    it("returns 0 when table is empty", () => {
      expect(repo.deleteWhereModelNot("m")).toBe(0);
    });
  });

  describe("ON DELETE CASCADE from skills", () => {
    it("deleting parent skill removes its embedding row", async () => {
      const id = await makeSkill("alpha");
      repo.upsert({ skillId: id, modelName: "m", dimension: 2, vector: vec([1, 0]) });
      expect(repo.findBySkillId(id)).not.toBeNull();

      // Delete via skill repo (takes slug, not id)
      const ok = await skillRepo.delete("alpha");
      expect(ok).toBe(true);
      expect(repo.findBySkillId(id)).toBeNull();
    });
  });

  describe("corrupt row detection", () => {
    it("raises when stored buffer length doesn't match dimension*4", async () => {
      const id = await makeSkill("alpha");
      // Hand-write a row with mismatched buffer (claims dim=4 but stores 3 floats)
      const badBuf = Buffer.from(new Float32Array([1, 0, 0]).buffer);
      const now = Date.now();
      rawSqlite
        .prepare(
          `INSERT INTO skill_embeddings (skill_id, model_name, dimension, vector, content_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, "m", 4, badBuf, null, now, now);

      expect(() => repo.findBySkillId(id)).toThrow(/corrupt row/);
    });
  });

  describe("Float32Array sub-buffer correctness", () => {
    it("round-trips when source vector is a sliced view of a larger buffer", async () => {
      const id = await makeSkill("alpha");
      // Allocate a wider buffer and take a sub-view — exercises the byteOffset
      // path in the repo's encoder/decoder.
      const big = new Float32Array(8);
      for (let i = 0; i < 8; i += 1) big[i] = i / 10;
      const sub = big.subarray(2, 6); // [0.2, 0.3, 0.4, 0.5]
      repo.upsert({ skillId: id, modelName: "m", dimension: 4, vector: sub });

      const got = repo.findBySkillId(id);
      expect(got!.vector.length).toBe(4);
      expect(got!.vector[0]).toBeCloseTo(0.2, 5);
      expect(got!.vector[1]).toBeCloseTo(0.3, 5);
      expect(got!.vector[2]).toBeCloseTo(0.4, 5);
      expect(got!.vector[3]).toBeCloseTo(0.5, 5);
    });
  });
});
