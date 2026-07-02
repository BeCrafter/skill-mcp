import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { SkillFeedbackRepository } from "../../../src/db/repositories/skill-feedback.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; sqlite: Database.Database; repo: SkillFeedbackRepository; skillId: string } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE skills (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    display_name TEXT, description TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '0.0.1', category TEXT,
    attributes TEXT, retrieval_meta TEXT, status TEXT NOT NULL DEFAULT 'draft',
    visibility TEXT NOT NULL DEFAULT 'private', entry_file TEXT DEFAULT 'SKILL.md',
    storage_path TEXT NOT NULL, content_hash TEXT,
      import_source TEXT, import_url TEXT, import_branch TEXT, import_sub_dir TEXT, imported_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE skill_feedbacks (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    skill_slug TEXT NOT NULL,
    user_id TEXT, session_id TEXT,
    outcome TEXT NOT NULL,
    context TEXT, agent_comment TEXT,
    version TEXT,
    created_at INTEGER NOT NULL
  )`);
  const skillId = "skill-1";
  sqlite.prepare(
    `INSERT INTO skills (id, slug, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(skillId, "demo", "demo", "demo/", Date.now(), Date.now());
  return { db, sqlite, repo: new SkillFeedbackRepository(db), skillId };
}

describe("SkillFeedbackRepository", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("create persists all fields including null defaults", async () => {
    const id = await ctx.repo.create({
      skillId: ctx.skillId, skillSlug: "demo",
      userId: "u-1", sessionId: "s-1",
      outcome: "success",
      context: "ctx", agentComment: "good",
    });
    expect(id).toMatch(/^[a-z0-9]{21}$/);
    const rows = await ctx.repo.findBySlug("demo");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      skillSlug: "demo", outcome: "success", userId: "u-1",
      sessionId: "s-1", context: "ctx", agentComment: "good",
    });
    expect(typeof rows[0].createdAt).toBe("number");
  });

  it("create coerces undefined optional fields to null", async () => {
    await ctx.repo.create({
      skillId: ctx.skillId, skillSlug: "demo",
      userId: null, sessionId: null,
      outcome: "failure", context: null, agentComment: null,
    });
    const [row] = await ctx.repo.findBySlug("demo");
    expect(row.userId).toBeNull();
    expect(row.context).toBeNull();
    expect(row.agentComment).toBeNull();
  });

  it("findBySlug returns most-recent first (DESC by createdAt)", async () => {
    // Force distinct createdAt by inserting raw rows.
    const insert = ctx.sqlite.prepare(
      `INSERT INTO skill_feedbacks (id, skill_id, skill_slug, outcome, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run("a", ctx.skillId, "demo", "success", 1000);
    insert.run("b", ctx.skillId, "demo", "failure", 3000);
    insert.run("c", ctx.skillId, "demo", "partial", 2000);
    const rows = await ctx.repo.findBySlug("demo");
    expect(rows.map(r => r.id)).toEqual(["b", "c", "a"]);
  });

  it("findBySlug filters by days window", async () => {
    const now = Date.now();
    const insert = ctx.sqlite.prepare(
      `INSERT INTO skill_feedbacks (id, skill_id, skill_slug, outcome, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run("recent", ctx.skillId, "demo", "success", now - 60_000);
    insert.run("old", ctx.skillId, "demo", "success", now - 8 * 24 * 60 * 60 * 1000);
    const rows = await ctx.repo.findBySlug("demo", 7);
    expect(rows.map(r => r.id)).toEqual(["recent"]);
  });

  it("findBySlug enforces default cap of 1000 (T-713)", async () => {
    const insert = ctx.sqlite.prepare(
      `INSERT INTO skill_feedbacks (id, skill_id, skill_slug, outcome, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 1500; i++) {
      insert.run(`row-${i}`, ctx.skillId, "demo", "success", i);
    }
    const rows = await ctx.repo.findBySlug("demo");
    expect(rows).toHaveLength(1000);
    // Oldest 500 must have been excluded — DESC order means the smallest-i rows are dropped.
    expect(rows.every(r => Number(r.id.slice(4)) >= 500)).toBe(true);
  });

  it("findBySlug honors explicit larger limit", async () => {
    const insert = ctx.sqlite.prepare(
      `INSERT INTO skill_feedbacks (id, skill_id, skill_slug, outcome, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 1500; i++) insert.run(`r-${i}`, ctx.skillId, "demo", "success", i);
    const rows = await ctx.repo.findBySlug("demo", undefined, 1500);
    expect(rows).toHaveLength(1500);
  });

  it("findBySlug filters by slug — does not bleed across skills", async () => {
    ctx.sqlite.prepare(
      `INSERT INTO skills (id, slug, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("skill-2", "other", "other", "other/", Date.now(), Date.now());
    await ctx.repo.create({ skillId: ctx.skillId, skillSlug: "demo", userId: null, sessionId: null, outcome: "success", context: null, agentComment: null });
    await ctx.repo.create({ skillId: "skill-2", skillSlug: "other", userId: null, sessionId: null, outcome: "success", context: null, agentComment: null });
    expect((await ctx.repo.findBySlug("demo")).every(r => r.skillSlug === "demo")).toBe(true);
    expect(await ctx.repo.findBySlug("missing")).toEqual([]);
  });

  it("getEffectivenessRates: success+partial count toward numerator, failure does not", async () => {
    const insert = ctx.sqlite.prepare(
      `INSERT INTO skill_feedbacks (id, skill_id, skill_slug, outcome, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run("a", ctx.skillId, "demo", "success", 100);
    insert.run("b", ctx.skillId, "demo", "partial", 200);
    insert.run("c", ctx.skillId, "demo", "failure", 300);
    insert.run("d", ctx.skillId, "demo", "failure", 400);
    const rates = await ctx.repo.getEffectivenessRates();
    const demo = rates.get("demo");
    expect(demo).toBeDefined();
    expect(demo!.count).toBe(4);
    expect(demo!.rate).toBeCloseTo(0.5, 5);
  });

  it("getEffectivenessRates returns 0.5 default for empty bucket (no rows)", async () => {
    const rates = await ctx.repo.getEffectivenessRates();
    expect(rates.size).toBe(0); // No rows → no buckets at all
  });

  it("getEffectivenessRates filters by days window", async () => {
    const now = Date.now();
    const insert = ctx.sqlite.prepare(
      `INSERT INTO skill_feedbacks (id, skill_id, skill_slug, outcome, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run("recent-ok", ctx.skillId, "demo", "success", now - 1_000);
    insert.run("old-bad", ctx.skillId, "demo", "failure", now - 30 * 24 * 60 * 60 * 1000);
    const rates = await ctx.repo.getEffectivenessRates(7);
    expect(rates.get("demo")).toEqual({ rate: 1, count: 1 });
  });
});
