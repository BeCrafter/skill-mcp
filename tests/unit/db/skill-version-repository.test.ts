import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { SkillVersionRepository } from "../../../src/db/repositories/skill-version.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; repo: SkillVersionRepository } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE skills (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    description TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '0.0.1',
    status TEXT NOT NULL DEFAULT 'draft', visibility TEXT NOT NULL DEFAULT 'private',
    storage_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE skill_versions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    entry_file TEXT DEFAULT 'SKILL.md',
    file_count INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    change_summary TEXT,
    created_at INTEGER NOT NULL
  )`);
  sqlite.prepare(
    `INSERT INTO skills (id, slug, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("skill-1", "demo", "demo", "demo/", Date.now(), Date.now());
  return { db, repo: new SkillVersionRepository(db) };
}

describe("SkillVersionRepository", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("create returns the row with all defaults filled", () => {
    const v = ctx.repo.create({
      skillId: "skill-1", version: "1.0.0",
      contentHash: "h-1", storagePath: "demo/",
      fileCount: 3,
    });
    expect(v.entryFile).toBe("SKILL.md");
    expect(v.createdBy).toBeNull();
    expect(v.changeSummary).toBeNull();
    expect(typeof v.createdAt).toBe("number");
  });

  it("create persists optional fields when provided", () => {
    const v = ctx.repo.create({
      skillId: "skill-1", version: "2.0.0",
      contentHash: "h-2", storagePath: "demo/",
      fileCount: 5, entryFile: "INDEX.md",
      createdBy: "alice", changeSummary: "major rewrite",
    });
    expect(v.entryFile).toBe("INDEX.md");
    expect(v.createdBy).toBe("alice");
    expect(v.changeSummary).toBe("major rewrite");
  });

  it("findBySkillId returns versions newest-first", async () => {
    ctx.repo.create({ skillId: "skill-1", version: "1.0.0", contentHash: "a", storagePath: "x", fileCount: 1 });
    await new Promise(r => setTimeout(r, 5));
    ctx.repo.create({ skillId: "skill-1", version: "1.1.0", contentHash: "b", storagePath: "x", fileCount: 1 });
    await new Promise(r => setTimeout(r, 5));
    ctx.repo.create({ skillId: "skill-1", version: "2.0.0", contentHash: "c", storagePath: "x", fileCount: 1 });
    const rows = ctx.repo.findBySkillId("skill-1");
    expect(rows.map(r => r.version)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
  });

  it("findBySkillId honors limit", () => {
    for (let i = 0; i < 5; i++) {
      ctx.repo.create({ skillId: "skill-1", version: `1.0.${i}`, contentHash: `h${i}`, storagePath: "x", fileCount: 1 });
    }
    expect(ctx.repo.findBySkillId("skill-1", 2)).toHaveLength(2);
  });

  it("findByVersion locates exact match (rollback path)", () => {
    ctx.repo.create({ skillId: "skill-1", version: "1.0.0", contentHash: "h-old", storagePath: "x", fileCount: 1 });
    ctx.repo.create({ skillId: "skill-1", version: "1.1.0", contentHash: "h-new", storagePath: "x", fileCount: 1 });
    const hit = ctx.repo.findByVersion("skill-1", "1.0.0");
    expect(hit?.contentHash).toBe("h-old");
    expect(ctx.repo.findByVersion("skill-1", "9.9.9")).toBeNull();
    expect(ctx.repo.findByVersion("missing-skill", "1.0.0")).toBeNull();
  });

  it("count counts only the targeted skill", () => {
    // Add a second skill so we can prove the WHERE clause isolates rows.
    const sqlite = (ctx.repo as unknown as { db: { $client: Database.Database } }).db.$client;
    sqlite.prepare(`INSERT INTO skills (id, slug, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("skill-2", "other", "other", "other/", Date.now(), Date.now());
    ctx.repo.create({ skillId: "skill-1", version: "1.0.0", contentHash: "a", storagePath: "x", fileCount: 1 });
    ctx.repo.create({ skillId: "skill-1", version: "1.0.1", contentHash: "b", storagePath: "x", fileCount: 1 });
    ctx.repo.create({ skillId: "skill-2", version: "1.0.0", contentHash: "c", storagePath: "y", fileCount: 1 });
    expect(ctx.repo.count("skill-1")).toBe(2);
    expect(ctx.repo.count("skill-2")).toBe(1);
  });

  it("deleteOldVersions keeps newest N and reports deletion count", async () => {
    for (let i = 0; i < 5; i++) {
      ctx.repo.create({ skillId: "skill-1", version: `1.0.${i}`, contentHash: `h${i}`, storagePath: "x", fileCount: 1 });
      await new Promise(r => setTimeout(r, 2));
    }
    const deleted = ctx.repo.deleteOldVersions("skill-1", 2);
    expect(deleted).toBe(3);
    const remaining = ctx.repo.findBySkillId("skill-1");
    expect(remaining.map(r => r.version)).toEqual(["1.0.4", "1.0.3"]);
  });

  it("deleteOldVersions is a no-op when within the keep limit", () => {
    ctx.repo.create({ skillId: "skill-1", version: "1.0.0", contentHash: "a", storagePath: "x", fileCount: 1 });
    expect(ctx.repo.deleteOldVersions("skill-1", 5)).toBe(0);
    expect(ctx.repo.count("skill-1")).toBe(1);
  });

  it("cascades on parent skill delete", () => {
    ctx.repo.create({ skillId: "skill-1", version: "1.0.0", contentHash: "a", storagePath: "x", fileCount: 1 });
    const sqlite = (ctx.repo as unknown as { db: { $client: Database.Database } }).db.$client;
    sqlite.prepare(`DELETE FROM skills WHERE id = ?`).run("skill-1");
    expect(ctx.repo.count("skill-1")).toBe(0);
  });
});
