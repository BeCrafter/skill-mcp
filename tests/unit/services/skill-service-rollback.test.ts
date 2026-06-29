import { describe, it, expect, vi } from "vitest";
import { SkillService } from "../../../src/services/skill.service.js";
import type { ISkillProvider } from "../../../src/provider/interface.js";
import type { ICacheProvider } from "../../../src/cache/provider.interface.js";
import type { IStorageProvider } from "../../../src/storage/provider.interface.js";
import type { SkillRepository } from "../../../src/db/repositories/skill.repository.js";
import type { SkillFileRepository } from "../../../src/db/repositories/skill-file.repository.js";
import type { SkillVersionRepository, SkillVersion } from "../../../src/db/repositories/skill-version.repository.js";
import type { Logger } from "pino";
import type { SkillMeta } from "../../../src/types/index.js";

const skill: SkillMeta = {
  id: "s1", slug: "demo", name: "demo", displayName: null,
  description: "", version: "1.2.0", category: null, tags: [],
  attributes: {}, status: "published", visibility: "private",
  entryFile: "SKILL.md", storagePath: "demo/", contentHash: "current-hash",
  createdAt: 0, updatedAt: 0,
};

const v100: SkillVersion = {
  id: "v1", skillId: "s1", version: "1.0.0",
  contentHash: "hash-100", storagePath: "demo/.versions/1.0.0/",
  entryFile: "SKILL.md", fileCount: 2,
  createdBy: null, changeSummary: null, createdAt: 0,
};

function makeProvider(s: SkillMeta | null = skill): ISkillProvider {
  return {
    listSkills: vi.fn().mockResolvedValue([]),
    getSkillMeta: vi.fn().mockResolvedValue(s),
    getSkillMetaById: vi.fn().mockResolvedValue(s),
    getSkillEntry: vi.fn().mockResolvedValue(""),
    getSkillFiles: vi.fn().mockResolvedValue([]),
    getSkillFileTree: vi.fn().mockResolvedValue([]),
    skillExists: vi.fn().mockResolvedValue(true),
  };
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

function makeLogger(): Logger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
  } as unknown as Logger;
}

function makeStorage(overrides?: Partial<IStorageProvider>): IStorageProvider {
  return {
    get: vi.fn().mockResolvedValue(Buffer.from("body")),
    exists: vi.fn().mockResolvedValue(true),
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

function makeVersionRepo(existingVersion: unknown = v100) {
  return {
    findByVersion: vi.fn().mockReturnValue(existingVersion),
    create: vi.fn(),
    update: vi.fn(),
  } as unknown as SkillVersionRepository;
}

describe("SkillService.rollbackToVersion", () => {
  it("throws when version repo / skill repo / storage are not configured", async () => {
    const service = new SkillService(makeProvider(), makeCache(), makeLogger());
    await expect(service.rollbackToVersion("demo", "1.0.0"))
      .rejects.toThrow(/not configured/);
  });

  it("throws SkillNotFoundError when slug does not resolve", async () => {
    const versionRepo = makeVersionRepo();
    const skillRepo = { update: vi.fn() } as unknown as SkillRepository;
    const service = new SkillService(
      makeProvider(null), makeCache(), makeLogger(),
      undefined, undefined, versionRepo, skillRepo, makeStorage(),
    );
    await expect(service.rollbackToVersion("ghost", "1.0.0"))
      .rejects.toThrow(/Skill not found/);
  });

  it("throws when target version row is missing", async () => {
    const versionRepo = makeVersionRepo(null);
    const skillRepo = { update: vi.fn() } as unknown as SkillRepository;
    const service = new SkillService(
      makeProvider(), makeCache(), makeLogger(),
      undefined, undefined, versionRepo, skillRepo, makeStorage(),
    );
    await expect(service.rollbackToVersion("demo", "9.9.9"))
      .rejects.toThrow(/Version 9.9.9 not found/);
  });

  it("happy path: snapshots current, restores target, bumps version, clears caches", async () => {
    const versionRepo = makeVersionRepo();
    const skillRepo = { update: vi.fn().mockResolvedValue(skill) } as unknown as SkillRepository;
    const cache = makeCache();
    const storage = makeStorage({
      listRecursive: vi.fn()
        .mockResolvedValueOnce(["SKILL.md", "ref.md", ".versions/old/x"])
        .mockResolvedValueOnce(["SKILL.md", "ref.md"]),
      get: vi.fn().mockResolvedValue(Buffer.from("payload")),
    });

    const service = new SkillService(
      makeProvider(), cache, makeLogger(),
      undefined, undefined, versionRepo, skillRepo, storage,
    );

    await service.rollbackToVersion("demo", "1.0.0", "patch");

    // Snapshot put: 2 files (excluding .versions/*) into demo/.versions/1.2.0/
    expect(storage.put).toHaveBeenCalledWith("demo/.versions/1.2.0/SKILL.md", expect.any(Buffer));
    expect(storage.put).toHaveBeenCalledWith("demo/.versions/1.2.0/ref.md", expect.any(Buffer));

    // Restore put: 2 files copied back to demo/
    expect(storage.put).toHaveBeenCalledWith("demo/SKILL.md", expect.any(Buffer));
    expect(storage.put).toHaveBeenCalledWith("demo/ref.md", expect.any(Buffer));

    // DB updated: bumped patch (1.2.0 → 1.2.1) and contentHash from target version
    expect(skillRepo.update).toHaveBeenCalledWith("s1", {
      version: "1.2.1",
      contentHash: "hash-100",
    });

    // New version record created for the rolled-back version
    expect(versionRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "s1",
      version: "1.2.1",
      contentHash: "hash-100",
      isCurrent: true,
    }));

    // Caches cleared for entry + file
    expect(cache.clearByPrefix).toHaveBeenCalledWith("skill:entry:demo");
    expect(cache.clearByPrefix).toHaveBeenCalledWith("skill:file:demo");
  });

  it("respects the bump argument when computing the new version", async () => {
    const versionRepo = makeVersionRepo();
    const skillRepo = { update: vi.fn().mockResolvedValue(skill) } as unknown as SkillRepository;
    const storage = makeStorage({
      listRecursive: vi.fn().mockResolvedValue([]),
    });

    const service = new SkillService(
      makeProvider(), makeCache(), makeLogger(),
      undefined, undefined, versionRepo, skillRepo, storage,
    );

    await service.rollbackToVersion("demo", "1.0.0", "minor");
    expect(skillRepo.update).toHaveBeenCalledWith("s1", expect.objectContaining({ version: "1.3.0" }));

    await service.rollbackToVersion("demo", "1.0.0", "major");
    expect(skillRepo.update).toHaveBeenCalledWith("s1", expect.objectContaining({ version: "2.0.0" }));
  });

  it("storage commit failure mid-way restores from pre-rollback snapshot and does not advance DB", async () => {
    const versionRepo = makeVersionRepo();
    const skillRepo = { update: vi.fn().mockResolvedValue(skill) } as unknown as SkillRepository;
    const cache = makeCache();

    const putMock = vi.fn().mockImplementation(async (path: string) => {
      if (path === "demo/SKILL.md") throw new Error("disk error during commit");
    });
    const storage = makeStorage({
      listRecursive: vi.fn()
        .mockResolvedValueOnce(["SKILL.md", "ref.md"])
        .mockResolvedValueOnce(["SKILL.md", "ref.md"])
        .mockResolvedValueOnce(["SKILL.md", "ref.md"]),
      get: vi.fn().mockResolvedValue(Buffer.from("payload")),
      put: putMock,
    });

    const service = new SkillService(
      makeProvider(), cache, makeLogger(),
      undefined, undefined, versionRepo, skillRepo, storage,
    );

    await expect(service.rollbackToVersion("demo", "1.0.0")).rejects.toThrow(/disk error/);

    // DB version pointer never advanced.
    expect(skillRepo.update).not.toHaveBeenCalled();
    // Compensation tried to restore from the snapshot path.
    const restorePuts = putMock.mock.calls.filter(([p]) => p === "demo/SKILL.md" || p === "demo/ref.md");
    expect(restorePuts.length).toBeGreaterThan(0);
    // Staging always cleaned.
    expect(storage.deleteDir).toHaveBeenCalledWith(expect.stringMatching(/^__staging__\/[a-z0-9]+\/$/));
  });

  it("DB update failure rolls back live storage from snapshot and does not poison cache", async () => {
    const versionRepo = makeVersionRepo();
    const skillRepo = {
      update: vi.fn().mockRejectedValue(new Error("DB locked")),
    } as unknown as SkillRepository;
    const cache = makeCache();
    const storage = makeStorage({
      listRecursive: vi.fn()
        .mockResolvedValueOnce(["SKILL.md"])
        .mockResolvedValueOnce(["SKILL.md"])
        .mockResolvedValueOnce(["SKILL.md"]),
      get: vi.fn().mockResolvedValue(Buffer.from("payload")),
    });

    const service = new SkillService(
      makeProvider(), cache, makeLogger(),
      undefined, undefined, versionRepo, skillRepo, storage,
    );

    await expect(service.rollbackToVersion("demo", "1.0.0")).rejects.toThrow(/DB locked/);

    // Cache must NOT be invalidated when the rollback failed.
    expect(cache.clearByPrefix).not.toHaveBeenCalled();
    expect(storage.deleteDir).toHaveBeenCalledWith(expect.stringMatching(/^__staging__\/[a-z0-9]+\/$/));
  });

  it("uses an isolated staging directory and cleans it up on the happy path", async () => {
    const versionRepo = makeVersionRepo();
    const skillRepo = { update: vi.fn().mockResolvedValue(skill) } as unknown as SkillRepository;
    const storage = makeStorage({
      listRecursive: vi.fn()
        .mockResolvedValueOnce(["SKILL.md"])
        .mockResolvedValueOnce(["SKILL.md"]),
      get: vi.fn().mockResolvedValue(Buffer.from("payload")),
    });

    const service = new SkillService(
      makeProvider(), makeCache(), makeLogger(),
      undefined, undefined, versionRepo, skillRepo, storage,
    );

    await service.rollbackToVersion("demo", "1.0.0");

    const stagingPuts = (storage.put as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as string)
      .filter(p => p.startsWith("__staging__/"));
    expect(stagingPuts.length).toBeGreaterThan(0);
    expect(stagingPuts.every(p => /^__staging__\/[a-z0-9]+\//.test(p))).toBe(true);
    expect(storage.deleteDir).toHaveBeenCalledWith(expect.stringMatching(/^__staging__\/[a-z0-9]+\/$/));
  });

  it("T-723: deletes live files absent from the target version before restoring", async () => {
    const versionRepo = makeVersionRepo();
    const skillRepo = { update: vi.fn().mockResolvedValue(skill) } as unknown as SkillRepository;
    const storage = makeStorage({
      listRecursive: vi.fn()
        .mockResolvedValueOnce(["SKILL.md", "ref.md", "extra.md"])
        .mockResolvedValueOnce(["SKILL.md", "ref.md"]),
      get: vi.fn().mockResolvedValue(Buffer.from("payload")),
    });

    const service = new SkillService(
      makeProvider(), makeCache(), makeLogger(),
      undefined, undefined, versionRepo, skillRepo, storage,
    );

    await service.rollbackToVersion("demo", "1.0.0");

    expect(storage.delete).toHaveBeenCalledWith("demo/extra.md");
    const deletedPaths = (storage.delete as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    expect(deletedPaths).not.toContain("demo/SKILL.md");
    expect(deletedPaths).not.toContain("demo/ref.md");
  });

  it("T-724: refreshes skill_files index via replaceAll with target version's files", async () => {
    const versionRepo = makeVersionRepo();
    const skillRepo = { update: vi.fn().mockResolvedValue(skill) } as unknown as SkillRepository;
    const skillFileRepo = {
      replaceAll: vi.fn().mockResolvedValue(undefined),
    } as unknown as SkillFileRepository;
    const storage = makeStorage({
      listRecursive: vi.fn()
        .mockResolvedValueOnce(["SKILL.md", "ref.md"])
        .mockResolvedValueOnce(["SKILL.md", "ref.md"]),
      get: vi.fn().mockResolvedValue(Buffer.from("body-bytes")),
    });

    const service = new SkillService(
      makeProvider(), makeCache(), makeLogger(),
      undefined, undefined, versionRepo, skillRepo, storage,
      undefined, skillFileRepo,
    );

    await service.rollbackToVersion("demo", "1.0.0");

    expect(skillFileRepo.replaceAll).toHaveBeenCalledTimes(1);
    const [skillId, rows] = (skillFileRepo.replaceAll as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(skillId).toBe("s1");
    expect(rows).toHaveLength(2);
    const paths = rows.map((r: { filePath: string }) => r.filePath).sort();
    expect(paths).toEqual(["SKILL.md", "ref.md"].sort());
    for (const row of rows) {
      expect(row.fileSize).toBe(10);
      expect(row.fileType).toBe("text");
    }
  });

  it("skips snapshot files whose storage.get returns null", async () => {
    const versionRepo = makeVersionRepo();
    const skillRepo = { update: vi.fn().mockResolvedValue(skill) } as unknown as SkillRepository;
    const storage = makeStorage({
      listRecursive: vi.fn()
        .mockResolvedValueOnce(["a.md", "b.md", "c.md"])
        .mockResolvedValueOnce([]),
      get: vi.fn()
        .mockResolvedValueOnce(Buffer.from("A"))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(Buffer.from("C")),
    });

    const service = new SkillService(
      makeProvider(), makeCache(), makeLogger(),
      undefined, undefined, versionRepo, skillRepo, storage,
    );

    await service.rollbackToVersion("demo", "1.0.0");

    expect(versionRepo.update).toHaveBeenCalledWith("v1", expect.objectContaining({ fileCount: 2 }));
  });
});
