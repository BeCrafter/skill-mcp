import { describe, it, expect, beforeEach } from "vitest";
import { createDatabase, closeDatabase } from "../../../src/db/connection.js";
import { SkillRepository, bumpVersion } from "../../../src/db/repositories/skill.repository.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DB_PATH = join(tmpdir(), `skill-mcp-test-${process.pid}.db`);

function createTestTables(db: ReturnType<typeof createDatabase>): void {
  const statements = [
    `CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      display_name TEXT, description TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '0.0.1', category TEXT DEFAULT NULL,
      tags TEXT, attributes TEXT, status TEXT NOT NULL DEFAULT 'draft',
      visibility TEXT NOT NULL DEFAULT 'private', entry_file TEXT DEFAULT 'SKILL.md',
      storage_path TEXT NOT NULL, content_hash TEXT, conditions TEXT,
      assigned_groups TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_slug ON skills(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name)`,
    `CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status)`,
    `CREATE INDEX IF NOT EXISTS idx_skills_visibility ON skills(visibility)`,
  ];
  for (const sql of statements) {
    db.run(sql);
  }
}

describe("SkillRepository", () => {
  let repo: SkillRepository;

  beforeEach(() => {
    closeDatabase();
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

    const db = createDatabase(TEST_DB_PATH);
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

  it("should store and retrieve tags as JSON array", async () => {
    await repo.create({
      slug: "tagged", name: "tagged",
      tags: ["prompt", "creative"],
      storagePath: "skills/tagged/",
    });

    const found = await repo.findBySlug("tagged");
    expect(found).not.toBeNull();
    expect(found!.tags).toEqual(["prompt", "creative"]);
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
