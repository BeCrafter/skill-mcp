import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { SkillRepository, bumpVersion } from "../../../src/db/repositories/skill.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function createTestTables(db: DrizzleDB): void {
  const statements = [
    `CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      display_name TEXT, description TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '0.0.1', category TEXT DEFAULT NULL,
      attributes TEXT, retrieval_meta TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      visibility TEXT NOT NULL DEFAULT 'private', entry_file TEXT DEFAULT 'SKILL.md',
      storage_path TEXT NOT NULL, content_hash TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS skill_tags (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (skill_id, tag)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_slug ON skills(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name)`,
    `CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status)`,
    `CREATE INDEX IF NOT EXISTS idx_skills_visibility ON skills(visibility)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS unique_name_content_hash ON skills(name, content_hash) WHERE content_hash IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_skill_tags_tag ON skill_tags(tag)`,
  ];
  for (const sql of statements) {
    db.run(sql);
  }
}

describe("SkillRepository", () => {
  let repo: SkillRepository;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    createTestTables(db);
    repo = new SkillRepository(db);
  });

  it("should create and find a skill", async () => {
    const skill = await repo.create({
      slug: "test-skill",
      name: "test-skill",
      description: "A test skill",
      storagePath: "skills/test-skill/",
      status: "published",
    });

    expect(skill.slug).toBe("test-skill");
    expect(skill.name).toBe("test-skill");
    expect(skill.description).toBe("A test skill");
    expect(skill.version).toBe("0.0.1");

    const found = await repo.findBySlug("test-skill");
    expect(found).not.toBeNull();
    expect(found!.slug).toBe("test-skill");
  });

  it("should find skills by name (multiple results)", async () => {
    await repo.create({
      slug: "test-skill-v1", name: "test-skill",
      version: "0.0.1", storagePath: "skills/test-skill-v1/",
    });
    await repo.create({
      slug: "test-skill-v2", name: "test-skill",
      version: "2.0.0", storagePath: "skills/test-skill-v2/",
    });

    const results = await repo.findByName("test-skill");
    expect(results).toHaveLength(2);
  });

  it("should update a skill", async () => {
    const skill = await repo.create({
      slug: "test-skill", name: "test-skill", storagePath: "skills/test-skill/",
    });

    const updated = await repo.update(skill.id, {
      description: "Updated description",
      category: "writing",
      tags: ["prompt"],
    });

    expect(updated).not.toBeNull();
    expect(updated!.description).toBe("Updated description");
    expect(updated!.category).toBe("writing");
    expect(updated!.tags).toEqual(["prompt"]);
  });

  it("persists storagePath / contentHash when updated (importer + rollback path) — T-728", async () => {
    // System callers (importer post-stage, rollback DB pointer) MUST be
    // able to rewrite these columns. Untrusted-input filtering happens at
    // the admin HTTP handler boundary, not here. See
    // `tests/unit/http/admin-skills-put.test.ts`.
    const skill = await repo.create({
      slug: "system-update", name: "system-update",
      storagePath: "skills/system-update/", contentHash: "old-hash",
    });

    await repo.update(skill.id, {
      storagePath: "skills/system-update/",
      contentHash: "new-hash",
    });

    const after = await repo.findById(skill.id);
    expect(after!.contentHash).toBe("new-hash");
  });

  it("should delete a skill", async () => {
    await repo.create({
      slug: "test-skill", name: "test-skill", storagePath: "skills/test-skill/",
    });

    const deleted = await repo.delete("test-skill");
    expect(deleted).toBe(true);

    const found = await repo.findBySlug("test-skill");
    expect(found).toBeNull();
  });

  it("should find all skills with status filter", async () => {
    await repo.create({
      slug: "skill-a", name: "skill-a", status: "published", storagePath: "skills/a/",
    });
    await repo.create({
      slug: "skill-b", name: "skill-b", status: "draft", storagePath: "skills/b/",
    });

    const published = await repo.findAll({ status: "published" });
    expect(published).toHaveLength(1);
    expect(published[0].slug).toBe("skill-a");

    const all = await repo.findAll();
    expect(all).toHaveLength(2);
  });

  it("should check if a skill exists", async () => {
    await repo.create({
      slug: "test-skill", name: "test-skill", storagePath: "skills/test-skill/",
    });

    expect(await repo.exists("test-skill")).toBe(true);
    expect(await repo.exists("nonexistent")).toBe(false);
  });

  it("should count skills", async () => {
    await repo.create({ slug: "a", name: "a", storagePath: "skills/a/" });
    await repo.create({ slug: "b", name: "b", storagePath: "skills/b/" });

    expect(await repo.count()).toBe(2);
  });

  it("should return null for non-existent id update", async () => {
    const result = await repo.update("non-existent-id", { description: "new" });
    expect(result).toBeNull();
  });

  it("should return false for non-existent slug delete", async () => {
    const result = await repo.delete("non-existent-slug");
    expect(result).toBe(false);
  });

  it("should find by id", async () => {
    const skill = await repo.create({
      slug: "test-skill", name: "test-skill", storagePath: "skills/test-skill/",
    });

    const found = await repo.findById(skill.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(skill.id);
  });

  it("should store and retrieve tags via the relation table", async () => {
    await repo.create({
      slug: "tagged", name: "tagged",
      tags: ["prompt", "creative"],
      storagePath: "skills/tagged/",
    });

    const found = await repo.findBySlug("tagged");
    expect(found).not.toBeNull();
    expect(found!.tags.sort()).toEqual(["creative", "prompt"]);
  });

  it("should not match a skill whose tag merely contains the query as a substring (regression for LIKE %x% bug)", async () => {
    await repo.create({
      slug: "frontend-skill", name: "frontend-skill", status: "published",
      tags: ["frontend"], storagePath: "skills/frontend-skill/",
    });
    await repo.create({
      slug: "end-skill", name: "end-skill", status: "published",
      tags: ["end"], storagePath: "skills/end-skill/",
    });

    const matchEnd = await repo.findAll({ tags: ["end"] });
    expect(matchEnd.map(s => s.slug)).toEqual(["end-skill"]);
  });

  it("multi-tag filter requires ALL tags (AND semantics)", async () => {
    await repo.create({
      slug: "fe-only", name: "fe-only", status: "published",
      tags: ["frontend"], storagePath: "skills/fe-only/",
    });
    await repo.create({
      slug: "fe-and-design", name: "fe-and-design", status: "published",
      tags: ["frontend", "design"], storagePath: "skills/fe-and-design/",
    });

    const both = await repo.findAll({ tags: ["frontend", "design"] });
    expect(both.map(s => s.slug)).toEqual(["fe-and-design"]);
  });

  it("deleting a skill cascades to its tag rows", async () => {
    const created = await repo.create({
      slug: "tagged-2", name: "tagged-2",
      tags: ["a", "b"], storagePath: "skills/tagged-2/",
    });

    await repo.delete("tagged-2");

    const after = await repo.findById(created.id);
    expect(after).toBeNull();
  });

  it("update with tags=[] clears existing tags", async () => {
    const created = await repo.create({
      slug: "clear-me", name: "clear-me",
      tags: ["x", "y"], storagePath: "skills/clear-me/",
    });
    await repo.update(created.id, { tags: [] });
    const found = await repo.findById(created.id);
    expect(found!.tags).toEqual([]);
  });

  it("should store and retrieve attributes as JSON object", async () => {
    await repo.create({
      slug: "attr", name: "attr",
      attributes: { language: "zh-CN", complexity: "advanced" },
      storagePath: "skills/attr/",
    });

    const found = await repo.findBySlug("attr");
    expect(found).not.toBeNull();
    expect(found!.attributes).toEqual({ language: "zh-CN", complexity: "advanced" });
  });

  it("should store content hash", async () => {
    await repo.create({
      slug: "hashed", name: "hashed",
      contentHash: "sha256:abc123",
      storagePath: "skills/hashed/",
    });

    const found = await repo.findBySlug("hashed");
    expect(found).not.toBeNull();
    expect(found!.contentHash).toBe("sha256:abc123");
  });

  it("findByNameAndHash returns the matching row when both fields agree", async () => {
    await repo.create({
      slug: "a", name: "shared-name",
      contentHash: "h-aaa", storagePath: "a/",
    });
    await repo.create({
      slug: "b", name: "shared-name",
      contentHash: "h-bbb", storagePath: "b/",
    });

    const hit = await repo.findByNameAndHash("shared-name", "h-bbb");
    expect(hit).not.toBeNull();
    expect(hit!.slug).toBe("b");

    const miss = await repo.findByNameAndHash("shared-name", "h-zzz");
    expect(miss).toBeNull();
  });

  it("(name, content_hash) UNIQUE index rejects duplicate content imports", async () => {
    await repo.create({
      slug: "first", name: "demo",
      contentHash: "same-hash", storagePath: "first/",
    });

    await expect(repo.create({
      slug: "second", name: "demo",
      contentHash: "same-hash", storagePath: "second/",
    })).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("findByIds returns all matching rows, hydrates tags, and is empty-safe", async () => {
    await repo.create({ slug: "a", name: "a", tags: ["x"], storagePath: "a/" });
    const b = await repo.create({ slug: "b", name: "b", tags: ["y", "z"], storagePath: "b/" });
    const c = await repo.create({ slug: "c", name: "c", storagePath: "c/" });

    const empty = await repo.findByIds([]);
    expect(empty).toEqual([]);

    const hits = await repo.findByIds([b.id, c.id, "missing-id"]);
    const bySlug = Object.fromEntries(hits.map(s => [s.slug, s]));
    expect(Object.keys(bySlug).sort()).toEqual(["b", "c"]);
    expect(bySlug.b.tags.sort()).toEqual(["y", "z"]);
    expect(bySlug.c.tags).toEqual([]);
  });

  it("(name, content_hash) UNIQUE index allows multiple rows when hash is NULL", async () => {
    // Partial unique index excludes NULL content_hash so legacy rows
    // without a hash don't collide with each other.
    await repo.create({ slug: "p1", name: "legacy", storagePath: "p1/" });
    await repo.create({ slug: "p2", name: "legacy", storagePath: "p2/" });

    const all = await repo.findByName("legacy");
    expect(all).toHaveLength(2);
  });

  it("T-721: hydrating a row with corrupt attributes JSON returns {} (not []) and bumps the parse-error counter", async () => {
    const { metrics } = await import("../../../src/telemetry/metrics.js");
    const created = await repo.create({
      slug: "corrupt-attrs",
      name: "corrupt-attrs",
      storagePath: "corrupt-attrs/",
    });
    // Corrupt the JSON column directly: bypass the typed insert path so we
    // simulate a manually-edited DB / pre-validation legacy row.
    const sqlite = (repo as unknown as { db: { $client: { exec(s: string): void } } }).db.$client;
    sqlite.exec(`UPDATE skills SET attributes = 'not-json{' WHERE id = '${created.id}'`);

    metrics.skillRowJsonParseErrors.reset();
    const hydrated = await repo.findById(created.id);
    expect(hydrated).not.toBeNull();
    expect(hydrated!.attributes).toEqual({});
    // Crucially, attributes is an object — not an array.
    expect(Array.isArray(hydrated!.attributes)).toBe(false);

    const text = await (await import("../../../src/telemetry/metrics.js")).registry.metrics();
    expect(text).toMatch(/skill_mcp_skill_row_json_parse_errors_total\{column="attributes"\}\s+1/);
  });

  it("T-721: a JSON array in attributes coerces to {} (consumers must see Record-shaped data)", async () => {
    const created = await repo.create({
      slug: "array-attrs",
      name: "array-attrs",
      storagePath: "array-attrs/",
    });
    const sqlite = (repo as unknown as { db: { $client: { exec(s: string): void } } }).db.$client;
    sqlite.exec(`UPDATE skills SET attributes = '[1,2,3]' WHERE id = '${created.id}'`);

    const hydrated = await repo.findById(created.id);
    expect(hydrated!.attributes).toEqual({});
    expect(Array.isArray(hydrated!.attributes)).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────
  // P1-11 stage 2a — retrieval-signal round-trip
  // ──────────────────────────────────────────────────────────────────────

  it("P1-11: round-trips retrieval_meta (triggers / whenToUse / embeddingText) through create + findBySlug", async () => {
    await repo.create({
      slug: "retrieval-rt", name: "retrieval-rt",
      storagePath: "skills/retrieval-rt/",
      retrievalMeta: {
        triggers: ["search files", "find regex"],
        whenToUse: "Use when the user wants to grep recursively.",
        embeddingText: "ripgrep wrapper; recursive directory pattern search",
      },
    });

    const found = await repo.findBySlug("retrieval-rt");
    expect(found!.retrievalMeta).toEqual({
      triggers: ["search files", "find regex"],
      whenToUse: "Use when the user wants to grep recursively.",
      embeddingText: "ripgrep wrapper; recursive directory pattern search",
    });
  });

  it("P1-11: legacy rows (no retrieval_meta written) hydrate as null, not {}", async () => {
    // create() with retrievalMeta omitted should leave the column NULL — that
    // 'never written' state must be distinguishable from 'written empty {}'.
    await repo.create({
      slug: "legacy-row", name: "legacy-row",
      storagePath: "skills/legacy-row/",
    });
    const found = await repo.findBySlug("legacy-row");
    expect(found!.retrievalMeta).toBeNull();
  });

  it("P1-11: passing retrievalMeta with all empty fields is treated as null (column stays NULL)", async () => {
    await repo.create({
      slug: "empty-rm", name: "empty-rm",
      storagePath: "skills/empty-rm/",
      retrievalMeta: { triggers: [], whenToUse: "", embeddingText: "" },
    });
    const found = await repo.findBySlug("empty-rm");
    expect(found!.retrievalMeta).toBeNull();
  });

  it("P1-11: update() can attach retrieval_meta to an existing row", async () => {
    const created = await repo.create({
      slug: "rm-update", name: "rm-update",
      storagePath: "skills/rm-update/",
    });
    await repo.update(created.id, {
      retrievalMeta: { triggers: ["a", "b"], whenToUse: "later" },
    });
    const after = await repo.findById(created.id);
    expect(after!.retrievalMeta).toEqual({ triggers: ["a", "b"], whenToUse: "later" });
  });

  it("P1-11: update() with retrievalMeta=null clears the column", async () => {
    const created = await repo.create({
      slug: "rm-clear", name: "rm-clear",
      storagePath: "skills/rm-clear/",
      retrievalMeta: { triggers: ["x"] },
    });
    expect((await repo.findById(created.id))!.retrievalMeta).toEqual({ triggers: ["x"] });

    await repo.update(created.id, { retrievalMeta: null });
    expect((await repo.findById(created.id))!.retrievalMeta).toBeNull();
  });

  it("P1-11: corrupt retrieval_meta JSON coerces to {} and bumps the parse-error counter", async () => {
    const { metrics } = await import("../../../src/telemetry/metrics.js");
    const created = await repo.create({
      slug: "corrupt-rm", name: "corrupt-rm",
      storagePath: "skills/corrupt-rm/",
    });
    const sqlite = (repo as unknown as { db: { $client: { exec(s: string): void } } }).db.$client;
    sqlite.exec(`UPDATE skills SET retrieval_meta = 'not-json{' WHERE id = '${created.id}'`);

    metrics.skillRowJsonParseErrors.reset();
    const hydrated = await repo.findById(created.id);
    expect(hydrated!.retrievalMeta).toEqual({});

    const text = await (await import("../../../src/telemetry/metrics.js")).registry.metrics();
    expect(text).toMatch(/skill_mcp_skill_row_json_parse_errors_total\{column="retrieval_meta"\}\s+1/);
  });

  it("P1-11: a JSON array in retrieval_meta coerces to {} (consumers expect Record-shaped data)", async () => {
    const created = await repo.create({
      slug: "array-rm", name: "array-rm",
      storagePath: "skills/array-rm/",
    });
    const sqlite = (repo as unknown as { db: { $client: { exec(s: string): void } } }).db.$client;
    sqlite.exec(`UPDATE skills SET retrieval_meta = '[1,2,3]' WHERE id = '${created.id}'`);

    const hydrated = await repo.findById(created.id);
    expect(hydrated!.retrievalMeta).toEqual({});
    expect(Array.isArray(hydrated!.retrievalMeta)).toBe(false);
  });
});

describe("bumpVersion", () => {
  it("should bump patch version", () => {
    expect(bumpVersion("0.0.1", "patch")).toBe("0.0.2");
    expect(bumpVersion("2.3.9", "patch")).toBe("2.3.10");
  });

  it("should bump minor version", () => {
    expect(bumpVersion("0.0.1", "minor")).toBe("0.1.0");
    expect(bumpVersion("0.9.9", "minor")).toBe("0.10.0");
  });

  it("should bump major version", () => {
    expect(bumpVersion("0.0.1", "major")).toBe("1.0.0");
  });

  it("should default to patch", () => {
    expect(bumpVersion("0.0.1")).toBe("0.0.2");
  });

  it("should return 0.0.1 for invalid versions", () => {
    expect(bumpVersion("invalid")).toBe("0.0.1");
    expect(bumpVersion("1.0")).toBe("0.0.1");
  });
});
