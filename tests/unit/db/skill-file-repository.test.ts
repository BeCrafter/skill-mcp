import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { SkillFileRepository } from "../../../src/db/repositories/skill-file.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; sqlite: Database.Database; repo: SkillFileRepository } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE skills (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '0.0.1',
    status TEXT NOT NULL DEFAULT 'draft', visibility TEXT NOT NULL DEFAULT 'private',
    storage_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE skill_files (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    checksum TEXT,
    created_at INTEGER NOT NULL
  )`);
  sqlite.prepare(
    `INSERT INTO skills (id, slug, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("skill-1", "demo", "demo", "demo/", Date.now(), Date.now());
  return { db, sqlite, repo: new SkillFileRepository(db) };
}

const sample = (path: string) => ({
  filePath: path, fileType: "md", fileSize: 100, mimeType: "text/markdown", checksum: "h-" + path,
});

describe("SkillFileRepository", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("create + findBySkillId returns the projected columns only", async () => {
    await ctx.repo.create("skill-1", sample("a.md"));
    const rows = await ctx.repo.findBySkillId("skill-1");
    expect(rows).toEqual([{ filePath: "a.md", fileType: "md", fileSize: 100, mimeType: "text/markdown" }]);
  });

  it("create defaults checksum to null when omitted", async () => {
    await ctx.repo.create("skill-1", { filePath: "x", fileType: "md", fileSize: 1, mimeType: "text/markdown" });
    const checksum = ctx.sqlite.prepare(`SELECT checksum FROM skill_files WHERE skill_id = ?`).get("skill-1") as { checksum: string | null };
    expect(checksum.checksum).toBeNull();
  });

  it("deleteBySkillId removes only that skill's rows", async () => {
    ctx.sqlite.prepare(`INSERT INTO skills (id, slug, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("skill-2", "other", "other", "other/", Date.now(), Date.now());
    await ctx.repo.create("skill-1", sample("a.md"));
    await ctx.repo.create("skill-2", sample("b.md"));
    await ctx.repo.deleteBySkillId("skill-1");
    expect(await ctx.repo.findBySkillId("skill-1")).toEqual([]);
    expect(await ctx.repo.findBySkillId("skill-2")).toHaveLength(1);
  });

  it("replaceAll is atomic — replaces in a transaction", async () => {
    await ctx.repo.create("skill-1", sample("old1.md"));
    await ctx.repo.create("skill-1", sample("old2.md"));
    await ctx.repo.replaceAll("skill-1", [sample("new1.md"), sample("new2.md"), sample("new3.md")]);
    const rows = await ctx.repo.findBySkillId("skill-1");
    expect(rows.map(r => r.filePath).sort()).toEqual(["new1.md", "new2.md", "new3.md"]);
  });

  it("replaceAll with empty array clears all rows", async () => {
    await ctx.repo.create("skill-1", sample("a.md"));
    await ctx.repo.create("skill-1", sample("b.md"));
    await ctx.repo.replaceAll("skill-1", []);
    expect(await ctx.repo.findBySkillId("skill-1")).toEqual([]);
  });

  it("replaceAll throws on FK violation and leaves unrelated skills untouched", async () => {
    await ctx.repo.create("skill-1", sample("preserved.md"));
    await expect(
      ctx.repo.replaceAll("ghost-skill", [sample("x.md")]),
    ).rejects.toThrow();
    const rows = await ctx.repo.findBySkillId("skill-1");
    expect(rows.map(r => r.filePath)).toEqual(["preserved.md"]);
  });

  it("cascades on parent skill delete", async () => {
    await ctx.repo.create("skill-1", sample("a.md"));
    ctx.sqlite.prepare(`DELETE FROM skills WHERE id = ?`).run("skill-1");
    expect(await ctx.repo.findBySkillId("skill-1")).toEqual([]);
  });
});
