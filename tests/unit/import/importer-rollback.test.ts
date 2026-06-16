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

function makeSkillRepo(overrides?: Partial<SkillRepository>): SkillRepository {
  return {
    findByName: vi.fn().mockResolvedValue([]),
    findBySlug: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: "new-skill-id", slug: "demo" } as SkillMeta),
    update: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as SkillRepository;
}

function makeFileRepo(overrides?: Partial<SkillFileRepository>): SkillFileRepository {
  return {
    deleteBySkillId: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    replaceAll: vi.fn().mockResolvedValue(undefined),
    findBySkillId: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as SkillFileRepository;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "importer-rollback-"));
  writeFileSync(join(tmpDir, "SKILL.md"), [
    "---",
    "name: demo",
    "version: 1.0.0",
    "description: test skill",
    "---",
    "",
    "# Demo skill",
    "Body content for the rollback test.",
  ].join("\n"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SkillImporter staging-commit rollback", () => {
  it("storage.put failure leaves no DB skill row and no staging files", async () => {
    const storage = makeStorage({
      put: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    const skillRepo = makeSkillRepo();
    const fileRepo = makeFileRepo();
    const importer = new SkillImporter(
      storage, skillRepo, fileRepo, makeCache(), makeLogger(),
    );

    await expect(importer.import(tmpDir, {})).rejects.toThrow(/disk full/);

    expect(skillRepo.create).not.toHaveBeenCalled();
    expect(skillRepo.update).not.toHaveBeenCalled();
    expect(fileRepo.replaceAll).not.toHaveBeenCalled();
    // staging cleanup attempted
    expect(storage.deleteDir).toHaveBeenCalledWith(
      expect.stringMatching(/^__staging__\/[a-z0-9]+\/$/),
    );
  });

  it("skillRepo.create failure leaves storage uncommitted and cleans staging", async () => {
    const storage = makeStorage();
    // Use a non-UNIQUE error so the importer doesn't try the
    // T-202 idempotent-recovery / slug-retry path.
    const skillRepo = makeSkillRepo({
      create: vi.fn().mockRejectedValue(new Error("DB write failed")),
    });
    const fileRepo = makeFileRepo();
    const importer = new SkillImporter(
      storage, skillRepo, fileRepo, makeCache(), makeLogger(),
    );

    await expect(importer.import(tmpDir, {})).rejects.toThrow(/DB write failed/);

    expect(skillRepo.create).toHaveBeenCalled();
    expect(fileRepo.replaceAll).not.toHaveBeenCalled();
    // T-202 reordered DB-before-storage: when create fails, moveDir
    // never runs, so finalPath is never touched.
    expect(storage.moveDir).not.toHaveBeenCalled();
    expect(storage.deleteDir).not.toHaveBeenCalledWith("demo/");
    // Staging cleanup still runs.
    expect(storage.deleteDir).toHaveBeenCalledWith(
      expect.stringMatching(/^__staging__\/[a-z0-9]+\/$/),
    );
  });

  it("skillFileRepo.replaceAll failure rolls back skill row + final storage", async () => {
    const storage = makeStorage();
    const skillRepo = makeSkillRepo({
      create: vi.fn().mockResolvedValue({ id: "new-skill-id", slug: "demo" } as SkillMeta),
    });
    const fileRepo = makeFileRepo({
      replaceAll: vi.fn().mockRejectedValue(new Error("file row insert failed")),
    });
    const importer = new SkillImporter(
      storage, skillRepo, fileRepo, makeCache(), makeLogger(),
    );

    await expect(importer.import(tmpDir, {})).rejects.toThrow(/file row insert failed/);

    expect(skillRepo.create).toHaveBeenCalled();
    expect(fileRepo.replaceAll).toHaveBeenCalled();
    // Compensating delete of the skill row we just created
    expect(skillRepo.delete).toHaveBeenCalledWith("demo");
    // Final storage rolled back
    expect(storage.deleteDir).toHaveBeenCalledWith("demo/");
  });

  it("concurrent imports use independent staging directories", async () => {
    const storage1 = makeStorage();
    const storage2 = makeStorage();
    const importer1 = new SkillImporter(
      storage1, makeSkillRepo(), makeFileRepo(), makeCache(), makeLogger(),
    );
    const importer2 = new SkillImporter(
      storage2, makeSkillRepo(), makeFileRepo(), makeCache(), makeLogger(),
    );

    await Promise.all([
      importer1.import(tmpDir, {}),
      importer2.import(tmpDir, {}),
    ]);

    const stagingPath1 = (storage1.put as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const stagingPath2 = (storage2.put as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const id1 = stagingPath1.match(/^__staging__\/([^/]+)\//)?.[1];
    const id2 = stagingPath2.match(/^__staging__\/([^/]+)\//)?.[1];
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toEqual(id2);
  });

  it("update path: storage failure restores pre-update skill row", async () => {
    // Regression: previously the update path wrote the new contentHash /
    // version / storagePath to the skills row *before* committing storage,
    // and the catch block had no compensating restore — so a storage failure
    // left the row pointing at bytes that didn't exist.
    const existing: SkillMeta = {
      id: "existing-id",
      slug: "demo",
      name: "demo",
      displayName: null,
      description: "old description",
      version: "1.0.0",
      category: "old-cat",
      tags: ["old-tag"],
      attributes: {},
      status: "published",
      visibility: "private",
      entryFile: "SKILL.md",
      storagePath: "demo/",
      contentHash: "sha256:old",
      createdAt: 1, updatedAt: 1,
    };
    const storage = makeStorage({
      // Stage succeeds, but the post-DB-update commit `put` throws.
      put: vi.fn().mockImplementation(async (path: string) => {
        if (path.startsWith("__staging__/")) return;
        throw new Error("storage commit failed");
      }),
    });
    const updateMock = vi.fn().mockResolvedValue(null);
    const skillRepo = makeSkillRepo({
      findByName: vi.fn().mockResolvedValue([existing]),
      findById: vi.fn().mockResolvedValue(existing),
      update: updateMock,
    });
    const fileRepo = makeFileRepo();
    const importer = new SkillImporter(
      storage, skillRepo, fileRepo, makeCache(), makeLogger(),
    );

    await expect(importer.import(tmpDir, { overwrite: true })).rejects.toThrow(/storage commit failed/);

    // The first update applied the new state; the second update restored it.
    expect(updateMock).toHaveBeenCalledTimes(2);
    const restoreCall = updateMock.mock.calls[1];
    expect(restoreCall[0]).toBe("existing-id");
    expect(restoreCall[1]).toMatchObject({
      contentHash: "sha256:old",
      version: "1.0.0",
      storagePath: "demo/",
      category: "old-cat",
      tags: ["old-tag"],
      description: "old description",
    });
    // Files were never persisted (storage commit failed before replaceAll).
    expect(fileRepo.replaceAll).not.toHaveBeenCalled();
  });

  it("happy path: stages, moves to final path, persists DB rows, cleans staging", async () => {
    const storage = makeStorage();
    const skillRepo = makeSkillRepo();
    const fileRepo = makeFileRepo();
    const importer = new SkillImporter(
      storage, skillRepo, fileRepo, makeCache(), makeLogger(),
    );

    const result = await importer.import(tmpDir, {});

    expect(result.action).toBe("created");
    expect(result.slug).toBe("demo");
    // Files were staged then moved
    const putCalls = (storage.put as ReturnType<typeof vi.fn>).mock.calls;
    expect(putCalls.length).toBeGreaterThan(0);
    expect(putCalls.every(([path]) => (path as string).startsWith("__staging__/"))).toBe(true);
    expect(storage.moveDir).toHaveBeenCalledWith(
      expect.stringMatching(/^__staging__\/[a-z0-9]+\/$/),
      "demo/",
    );
    expect(skillRepo.create).toHaveBeenCalled();
    expect(fileRepo.replaceAll).toHaveBeenCalledWith("new-skill-id", expect.any(Array));
    // staging cleanup
    expect(storage.deleteDir).toHaveBeenCalledWith(
      expect.stringMatching(/^__staging__\/[a-z0-9]+\/$/),
    );
  });
});
