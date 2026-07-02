import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { RoleRepository } from "../../../src/db/repositories/role.repository.js";
import { metrics, registry } from "../../../src/telemetry/metrics.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; sqlite: Database.Database; repo: RoleRepository } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE roles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
    tags TEXT NOT NULL,
    created_at INTEGER, updated_at INTEGER
  )`);
  return { db, sqlite, repo: new RoleRepository(db) };
}

describe("RoleRepository", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("create stores tags as JSON and round-trips them", async () => {
    const r = await ctx.repo.create({ name: "alpha", description: "d", tags: ["red", "blue"] });
    expect(r.tags).toEqual(["red", "blue"]);
    expect(r.description).toBe("d");

    const raw = ctx.sqlite.prepare(`SELECT tags FROM roles WHERE id = ?`).get(r.id) as { tags: string };
    expect(JSON.parse(raw.tags)).toEqual(["red", "blue"]);
  });

  it("create allows empty tag list", async () => {
    const r = await ctx.repo.create({ name: "empty", tags: [] });
    expect(r.tags).toEqual([]);
  });

  it("findByName looks up by unique name", async () => {
    await ctx.repo.create({ name: "alpha", tags: ["x"] });
    expect((await ctx.repo.findByName("alpha"))?.tags).toEqual(["x"]);
    expect(await ctx.repo.findByName("beta")).toBeNull();
  });

  it("findAll returns all roles", async () => {
    await ctx.repo.create({ name: "a", tags: [] });
    await ctx.repo.create({ name: "b", tags: [] });
    expect((await ctx.repo.findAll()).map(r => r.name).sort()).toEqual(["a", "b"]);
  });

  it("findByIds: empty array returns [] without query", async () => {
    expect(await ctx.repo.findByIds([])).toEqual([]);
  });

  it("findByIds: returns matching subset, drops unknown ids silently", async () => {
    const a = await ctx.repo.create({ name: "a", tags: ["x"] });
    const b = await ctx.repo.create({ name: "b", tags: ["y"] });
    const hits = await ctx.repo.findByIds([a.id, "missing", b.id]);
    expect(hits.map(r => r.name).sort()).toEqual(["a", "b"]);
  });

  it("update can change tags and persists JSON", async () => {
    const r = await ctx.repo.create({ name: "r", tags: ["old"] });
    const after = await ctx.repo.update(r.id, { tags: ["new1", "new2"] });
    expect(after?.tags).toEqual(["new1", "new2"]);
  });

  it("update partial fields preserves untouched columns", async () => {
    const r = await ctx.repo.create({ name: "r", description: "keep", tags: ["t"] });
    const after = await ctx.repo.update(r.id, { description: "changed" });
    expect(after?.description).toBe("changed");
    expect(after?.tags).toEqual(["t"]);
    expect(after?.name).toBe("r");
  });

  it("update returns null for unknown id", async () => {
    expect(await ctx.repo.update("nope", { name: "x" })).toBeNull();
  });

  it("delete removes the role and is idempotent on second call", async () => {
    const r = await ctx.repo.create({ name: "r", tags: [] });
    expect(await ctx.repo.delete(r.id)).toBe(true);
    expect(await ctx.repo.delete(r.id)).toBe(false);
  });

  it("name UNIQUE constraint rejects duplicate names", async () => {
    await ctx.repo.create({ name: "dup", tags: [] });
    await expect(ctx.repo.create({ name: "dup", tags: [] })).rejects.toThrow(/already exists/);
  });

  it("T-712: corrupt tags JSON is parsed as [] and the metric counter increments", async () => {
    metrics.roleTagsParseErrors.reset();
    const r = await ctx.repo.create({ name: "corrupt", tags: ["a"] });
    ctx.sqlite.prepare(`UPDATE roles SET tags = ? WHERE id = ?`).run("not-json{", r.id);
    const hydrated = await ctx.repo.findById(r.id);
    expect(hydrated?.tags).toEqual([]);
    const text = await registry.metrics();
    expect(text).toMatch(/skill_mcp_role_tags_parse_errors_total\s+1/);
  });

  it("T-712: tags JSON that parses as a non-array (object) coerces to []", async () => {
    metrics.roleTagsParseErrors.reset();
    const r = await ctx.repo.create({ name: "obj-tags", tags: ["a"] });
    ctx.sqlite.prepare(`UPDATE roles SET tags = ? WHERE id = ?`).run(`{"foo":"bar"}`, r.id);
    expect((await ctx.repo.findById(r.id))?.tags).toEqual([]);
    const text = await registry.metrics();
    expect(text).toMatch(/skill_mcp_role_tags_parse_errors_total\s+1/);
  });

  it("T-712: tags JSON array filters non-string entries silently", async () => {
    const r = await ctx.repo.create({ name: "mixed", tags: ["a"] });
    ctx.sqlite.prepare(`UPDATE roles SET tags = ? WHERE id = ?`).run(`["good", 42, null, "also-good"]`, r.id);
    expect((await ctx.repo.findById(r.id))?.tags).toEqual(["good", "also-good"]);
  });
});
