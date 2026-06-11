import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { AccessLogRepository } from "../../../src/db/repositories/access-log.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; sqlite: Database.Database; repo: AccessLogRepository } {
  const sqlite = new Database(":memory:");
  // Skip the FK constraint here so we can insert access_logs without a skills row;
  // cascade behavior is exercised separately in access-logs-cascade.test.ts.
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE access_logs (
    id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, skill_slug TEXT NOT NULL, action TEXT NOT NULL,
    file_paths TEXT, latency_ms INTEGER, user_id TEXT, session_id TEXT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    created_at INTEGER NOT NULL
  )`);
  return { db, sqlite, repo: new AccessLogRepository(db) };
}

describe("AccessLogRepository", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("create persists JSON-stringified filePaths", async () => {
    await ctx.repo.create({
      skillId: "s1", skillSlug: "demo", action: "view",
      filePaths: ["a.md", "b.md"], latencyMs: 5, userId: "u1", sessionId: "sess",
    });
    const raw = ctx.sqlite.prepare(`SELECT file_paths, latency_ms, user_id, session_id FROM access_logs`).get() as {
      file_paths: string; latency_ms: number; user_id: string; session_id: string;
    };
    expect(JSON.parse(raw.file_paths)).toEqual(["a.md", "b.md"]);
    expect(raw.latency_ms).toBe(5);
    expect(raw.user_id).toBe("u1");
    expect(raw.session_id).toBe("sess");
  });

  it("create stores NULL when filePaths is omitted", async () => {
    await ctx.repo.create({ skillId: "s1", skillSlug: "demo", action: "view" });
    const raw = ctx.sqlite.prepare(`SELECT file_paths, latency_ms, user_id FROM access_logs`).get() as {
      file_paths: string | null; latency_ms: number | null; user_id: string | null;
    };
    expect(raw.file_paths).toBeNull();
    expect(raw.latency_ms).toBeNull();
    expect(raw.user_id).toBeNull();
  });

  it("findBySkill round-trips entries and parses filePaths", async () => {
    await ctx.repo.create({ skillId: "s1", skillSlug: "demo", action: "view", filePaths: ["a.md"] });
    await ctx.repo.create({ skillId: "s1", skillSlug: "demo", action: "file-read", filePaths: ["a.md", "b.md"] });
    await ctx.repo.create({ skillId: "s2", skillSlug: "other", action: "view" });

    const hits = await ctx.repo.findBySkill("demo");
    expect(hits).toHaveLength(2);
    expect(hits.every(h => h.skillSlug === "demo")).toBe(true);
    expect(hits.find(h => h.action === "file-read")?.filePaths).toEqual(["a.md", "b.md"]);
  });

  it("findBySkill respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.repo.create({ skillId: "s1", skillSlug: "demo", action: "view" });
    }
    expect(await ctx.repo.findBySkill("demo", 2)).toHaveLength(2);
  });

  it("findBySkill returns [] for unknown slug", async () => {
    expect(await ctx.repo.findBySkill("nope")).toEqual([]);
  });

  it("T-716: a corrupt file_paths JSON row drops the value but does not throw", async () => {
    await ctx.repo.create({ skillId: "s1", skillSlug: "demo", action: "view", filePaths: ["good.md"] });
    // Mutate one row to corrupt JSON to simulate disk/manual corruption.
    ctx.sqlite.prepare(`UPDATE access_logs SET file_paths = ? WHERE skill_slug = ?`).run("not-json{", "demo");
    await ctx.repo.create({ skillId: "s1", skillSlug: "demo", action: "view", filePaths: ["fine.md"] });

    const hits = await ctx.repo.findBySkill("demo");
    expect(hits).toHaveLength(2);
    const corrupt = hits.find(h => h.filePaths === undefined);
    const ok = hits.find(h => Array.isArray(h.filePaths));
    expect(corrupt).toBeDefined();
    expect(ok?.filePaths).toEqual(["fine.md"]);
  });

  it("T-716: file_paths that parses as a non-array JSON object is dropped (undefined)", async () => {
    await ctx.repo.create({ skillId: "s1", skillSlug: "demo", action: "view", filePaths: ["a.md"] });
    ctx.sqlite.prepare(`UPDATE access_logs SET file_paths = ?`).run(`{"foo":"bar"}`);
    const hits = await ctx.repo.findBySkill("demo");
    expect(hits[0]?.filePaths).toBeUndefined();
  });

  it("T-716: array with non-string entries is filtered, not dropped wholesale", async () => {
    await ctx.repo.create({ skillId: "s1", skillSlug: "demo", action: "view", filePaths: ["a.md"] });
    ctx.sqlite.prepare(`UPDATE access_logs SET file_paths = ?`).run(`["good.md", 42, null, "also.md"]`);
    const hits = await ctx.repo.findBySkill("demo");
    expect(hits[0]?.filePaths).toEqual(["good.md", "also.md"]);
  });
});
