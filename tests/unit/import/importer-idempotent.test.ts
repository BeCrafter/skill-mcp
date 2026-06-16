import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillImporter } from "../../../src/import/importer.js";
import type { IStorageProvider } from "../../../src/storage/provider.interface.js";
import type { ICacheProvider } from "../../../src/cache/provider.interface.js";
import type { SkillRepository } from "../../../src/db/repositories/skill.repository.js";
import type { SkillFileRepository } from "../../../src/db/repositories/skill-file.repository.js";
import type { Logger } from "pino";
import type { SkillMeta } from "../../../src/types/index.js";

function makeStorage(overrides?: Partial<IStorageProvider>): IStorageProvider {
  return {
    get: vi.fn().mockResolvedValue(Buffer.from("data")),
    exists: vi.fn().mockResolvedValue(false),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteDir: vi.fn().mockResolvedValue(undefined),
    moveDir: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    listRecursive: vi.fn().mockResolvedValue([]),
    isDirectory: vi.fn().mockResolvedValue(true),
    size: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
  } as unknown as Logger;
}

function makeCache(): ICacheProvider {
  return {
    get: vi.fn().mockResolvedValue(null),
    getWithMeta: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    delete: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    clearByPrefix: vi.fn().mockResolvedValue(undefined),
  };
}

function uniqueErr(): Error {
  return Object.assign(new Error("UNIQUE constraint failed: skills.name, skills.content_hash"), {
    code: "SQLITE_CONSTRAINT_UNIQUE",
  });
}

function slugUniqueErr(): Error {
  return Object.assign(new Error("UNIQUE constraint failed: skills.slug"), {
    code: "SQLITE_CONSTRAINT_UNIQUE",
  });
}

function fakeWinner(slug: string, hash: string): SkillMeta {
  return {
    id: `winner-${slug}`,
    slug,
    name: "demo",
    displayName: null,
    description: "",
    version: "1.0.0",
    category: null,
    tags: [],
    attributes: {},
    status: "published",
    visibility: "private",
    entryFile: "SKILL.md",
    storagePath: `${slug}/`,
    contentHash: hash,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeSkillRepo(overrides?: Partial<SkillRepository>): SkillRepository {
  return {
    findByName: vi.fn().mockResolvedValue([]),
    findBySlug: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    findByNameAndHash: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: "new-id", slug: "demo" } as SkillMeta),
    update: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as SkillRepository;
}

function makeFileRepo(): SkillFileRepository {
  return {
    deleteBySkillId: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    replaceAll: vi.fn().mockResolvedValue(undefined),
    findBySkillId: vi.fn().mockResolvedValue([]),
  } as unknown as SkillFileRepository;
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "importer-idempotent-"));
  writeFileSync(join(tmpDir, "SKILL.md"), [
    "---",
    "name: demo",
    "version: 1.0.0",
    "description: idempotent skill",
    "---",
    "",
    "# Demo",
    "Body.",
  ].join("\n"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SkillImporter T-202 idempotency", () => {
  it("recovers concurrent winner via findByNameAndHash on (name, content_hash) UNIQUE conflict", async () => {
    const storage = makeStorage();
    const skillRepo = makeSkillRepo({
      // Race: between findByName and create, another importer landed.
      create: vi.fn().mockRejectedValueOnce(uniqueErr()),
      findByNameAndHash: vi.fn().mockImplementation(async (_name, hash) => fakeWinner("demo", hash as string)),
    });
    const importer = new SkillImporter(
      storage, skillRepo, makeFileRepo(), makeCache(), makeLogger(),
    );

    const result = await importer.import(tmpDir, {});

    expect(result.action).toBe("updated");
    expect(result.id).toBe("winner-demo");
    expect(result.slug).toBe("demo");
    // Recovered without committing storage or writing file rows.
    expect(storage.moveDir).not.toHaveBeenCalled();
    // Staging is still cleaned up.
    expect(storage.deleteDir).toHaveBeenCalledWith(
      expect.stringMatching(/^__staging__\/[a-z0-9]+\/$/),
    );
  });

  it("retries with bumped slug on slug UNIQUE conflict when allowDuplicate=true", async () => {
    const storage = makeStorage();
    const created = { id: "new-id", slug: "demo-2" } as SkillMeta;
    const createSpy = vi.fn()
      .mockRejectedValueOnce(slugUniqueErr())   // first attempt with "demo"
      .mockResolvedValueOnce(created);          // second attempt with bumped slug
    const skillRepo = makeSkillRepo({
      create: createSpy,
      findByNameAndHash: vi.fn().mockResolvedValue(null), // not a (name, hash) clash
      findBySlug: vi.fn()
        .mockResolvedValueOnce(null)            // initial pre-check for slug "demo"
        .mockResolvedValueOnce({ slug: "demo" } as SkillMeta) // first try in uniqueSlug: "demo" exists
        .mockResolvedValueOnce(null),           // "demo-2" is free
      findByName: vi.fn().mockResolvedValue([{ slug: "demo", version: "1.0.0" } as SkillMeta]),
    });
    const importer = new SkillImporter(
      storage, skillRepo, makeFileRepo(), makeCache(), makeLogger(),
    );

    const result = await importer.import(tmpDir, { allowDuplicate: true });

    expect(createSpy).toHaveBeenCalledTimes(2);
    // Second call had a bumped slug.
    const slugs = createSpy.mock.calls.map((args) => (args[0] as { slug: string }).slug);
    expect(slugs[1]).not.toEqual(slugs[0]);
    expect(result.slug).toBe("demo-2");
  });

  it("surfaces non-UNIQUE create errors immediately (no retry, no recovery)", async () => {
    const storage = makeStorage();
    const skillRepo = makeSkillRepo({
      create: vi.fn().mockRejectedValue(new Error("some other DB error")),
    });
    const importer = new SkillImporter(
      storage, skillRepo, makeFileRepo(), makeCache(), makeLogger(),
    );

    await expect(importer.import(tmpDir, {})).rejects.toThrow(/some other DB error/);
    expect(skillRepo.create).toHaveBeenCalledTimes(1);
    expect(skillRepo.findByNameAndHash).not.toHaveBeenCalled();
  });

  it("surfaces slug UNIQUE conflicts when allowDuplicate is not set", async () => {
    const storage = makeStorage();
    const skillRepo = makeSkillRepo({
      create: vi.fn().mockRejectedValue(slugUniqueErr()),
      findByNameAndHash: vi.fn().mockResolvedValue(null),
    });
    const importer = new SkillImporter(
      storage, skillRepo, makeFileRepo(), makeCache(), makeLogger(),
    );

    await expect(importer.import(tmpDir, {})).rejects.toThrow(/UNIQUE constraint/);
    expect(skillRepo.create).toHaveBeenCalledTimes(1);
  });

  it("idempotent recovery does not delete the recovered winner", async () => {
    const storage = makeStorage();
    const skillRepo = makeSkillRepo({
      create: vi.fn().mockRejectedValueOnce(uniqueErr()),
      findByNameAndHash: vi.fn().mockResolvedValue(fakeWinner("demo", "h1")),
    });
    const fileRepo = makeFileRepo();
    const importer = new SkillImporter(
      storage, skillRepo, fileRepo, makeCache(), makeLogger(),
    );

    await importer.import(tmpDir, {});

    expect(skillRepo.delete).not.toHaveBeenCalled();
    expect(fileRepo.replaceAll).not.toHaveBeenCalled();
    // No stomping on the winner's final path.
    expect(storage.deleteDir).not.toHaveBeenCalledWith("demo/");
  });
});
