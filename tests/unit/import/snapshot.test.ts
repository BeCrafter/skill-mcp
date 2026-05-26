import { describe, it, expect, vi } from "vitest";
import { SkillImporter } from "../../../src/import/importer.js";
import type { IStorageProvider } from "../../../src/storage/provider.interface.js";
import type { ICacheProvider } from "../../../src/cache/provider.interface.js";
import type { SkillRepository } from "../../../src/db/repositories/skill.repository.js";
import type { SkillFileRepository } from "../../../src/db/repositories/skill-file.repository.js";
import type { SkillVersionRepository } from "../../../src/db/repositories/skill-version.repository.js";
import type { Logger } from "pino";
import type { SkillMeta } from "../../../src/types/index.js";

const baseSkill: SkillMeta = {
  id: "skill-1", slug: "demo", name: "demo", displayName: null,
  description: "", version: "1.0.0", category: null, tags: [],
  attributes: {}, status: "published", visibility: "private",
  entryFile: "SKILL.md", storagePath: "demo/", contentHash: "h1",
  createdAt: 0, updatedAt: 0,
};

function makeStorage(overrides?: Partial<IStorageProvider>): IStorageProvider {
  return {
    get: vi.fn().mockResolvedValue(Buffer.from("data")),
    exists: vi.fn().mockResolvedValue(true),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteDir: vi.fn().mockResolvedValue(undefined),
    moveDir: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    listRecursive: vi.fn().mockResolvedValue(["SKILL.md", "ref.md"]),
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

function makeImporter(opts: {
  storage: IStorageProvider;
  versionRepo?: SkillVersionRepository;
  logger?: Logger;
}): { importer: SkillImporter; logger: Logger } {
  const logger = opts.logger ?? makeLogger();
  const importer = new SkillImporter(
    opts.storage,
    {} as SkillRepository,
    {} as SkillFileRepository,
    {} as ICacheProvider,
    logger,
    undefined,
    opts.versionRepo,
  );
  return { importer, logger };
}

function callSnapshot(importer: SkillImporter, skill: SkillMeta): Promise<void> {
  return (importer as unknown as { snapshotCurrentVersion(s: SkillMeta): Promise<void> })
    .snapshotCurrentVersion(skill);
}

describe("SkillImporter.snapshotCurrentVersion", () => {
  it("is a no-op when versionRepo is not configured", async () => {
    const storage = makeStorage();
    const { importer } = makeImporter({ storage });

    await callSnapshot(importer, baseSkill);

    expect(storage.listRecursive).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("copies files and records version row on the happy path", async () => {
    const storage = makeStorage({
      listRecursive: vi.fn().mockResolvedValue(["SKILL.md", "ref.md", ".versions/old/x"]),
      get: vi.fn().mockResolvedValue(Buffer.from("payload")),
    });
    const versionRepo = {
      create: vi.fn(),
    } as unknown as SkillVersionRepository;

    const { importer } = makeImporter({ storage, versionRepo });
    await callSnapshot(importer, baseSkill);

    // Should skip the .versions/* path
    expect(storage.put).toHaveBeenCalledTimes(2);
    expect(storage.put).toHaveBeenCalledWith("demo/.versions/1.0.0/SKILL.md", expect.any(Buffer));
    expect(storage.put).toHaveBeenCalledWith("demo/.versions/1.0.0/ref.md", expect.any(Buffer));
    expect(versionRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "skill-1",
      version: "1.0.0",
      contentHash: "h1",
      storagePath: "demo/.versions/1.0.0/",
      fileCount: 2,
    }));
  });

  it("swallows listRecursive failures and warns instead of throwing", async () => {
    const storage = makeStorage({
      listRecursive: vi.fn().mockRejectedValue(new Error("storage offline")),
    });
    const versionRepo = { create: vi.fn() } as unknown as SkillVersionRepository;
    const { importer, logger } = makeImporter({ storage, versionRepo });

    await expect(callSnapshot(importer, baseSkill)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: "skill-1", version: "1.0.0" }),
      "Failed to snapshot version",
    );
    expect(versionRepo.create).not.toHaveBeenCalled();
  });

  it("swallows storage.put failures during copy and does not record the version", async () => {
    const storage = makeStorage({
      listRecursive: vi.fn().mockResolvedValue(["SKILL.md"]),
      get: vi.fn().mockResolvedValue(Buffer.from("x")),
      put: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    const versionRepo = { create: vi.fn() } as unknown as SkillVersionRepository;
    const { importer, logger } = makeImporter({ storage, versionRepo });

    await expect(callSnapshot(importer, baseSkill)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(versionRepo.create).not.toHaveBeenCalled();
  });

  it("counts only files that returned content (skips null gets)", async () => {
    const storage = makeStorage({
      listRecursive: vi.fn().mockResolvedValue(["a.md", "b.md", "c.md"]),
      get: vi.fn()
        .mockResolvedValueOnce(Buffer.from("A"))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(Buffer.from("C")),
    });
    const versionRepo = { create: vi.fn() } as unknown as SkillVersionRepository;
    const { importer } = makeImporter({ storage, versionRepo });

    await callSnapshot(importer, baseSkill);

    expect(storage.put).toHaveBeenCalledTimes(2);
    expect(versionRepo.create).toHaveBeenCalledWith(expect.objectContaining({ fileCount: 2 }));
  });
});
