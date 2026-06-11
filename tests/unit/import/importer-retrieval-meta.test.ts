import { describe, it, expect, vi } from "vitest";
import { SkillImporter } from "../../../src/import/importer.js";
import { GitSourceResolver } from "../../../src/import/git-source.js";
import type { IStorageProvider } from "../../../src/storage/provider.interface.js";
import type { ICacheProvider } from "../../../src/cache/provider.interface.js";
import type { SkillRepository } from "../../../src/db/repositories/skill.repository.js";
import type { SkillFileRepository } from "../../../src/db/repositories/skill-file.repository.js";
import type { Logger } from "pino";

/**
 * P1-11 stage 2a — verify the importer projects validated SKILL.md frontmatter
 * retrieval signals into the `retrievalMeta` envelope passed to
 * SkillRepository.create / update. Without this wiring the column would always
 * persist as NULL and stage 2b's BM25 indexer would have nothing to read.
 */

function makeStorage(): IStorageProvider {
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

function makeSkillRepo(createImpl?: (input: unknown) => unknown): { repo: SkillRepository; createSpy: ReturnType<typeof vi.fn> } {
  const createSpy = vi.fn().mockImplementation(async (input: unknown) => {
    if (createImpl) return createImpl(input);
    return { id: "new-id", slug: (input as { slug: string }).slug };
  });
  const repo = {
    findByName: vi.fn().mockResolvedValue([]),
    findBySlug: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    findByNameAndHash: vi.fn().mockResolvedValue(null),
    create: createSpy,
    update: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
  } as unknown as SkillRepository;
  return { repo, createSpy };
}

function makeFileRepo(): SkillFileRepository {
  return {
    replaceAll: vi.fn().mockResolvedValue(undefined),
    findBySkillId: vi.fn().mockResolvedValue([]),
  } as unknown as SkillFileRepository;
}

function buildSkillFiles(frontmatter: string) {
  return [
    {
      path: "SKILL.md",
      buffer: Buffer.from(`---\n${frontmatter}\n---\n\n# Body\n`),
    },
  ];
}

describe("SkillImporter P1-11 stage 2a — retrieval signal wiring", () => {
  it("forwards triggers / when_to_use / embedding_text to skillRepo.create as retrievalMeta", async () => {
    vi.spyOn(GitSourceResolver.prototype, "resolve").mockResolvedValueOnce(
      buildSkillFiles(`name: demo
version: 1.0.0
description: A demo skill
triggers:
  - "search files"
  - "find regex"
when_to_use: "Use when the user wants to grep recursively."
embedding_text: "ripgrep wrapper; recursive directory pattern search"`),
    );

    const { repo, createSpy } = makeSkillRepo();
    const importer = new SkillImporter(
      makeStorage(), repo, makeFileRepo(), makeCache(), makeLogger(),
    );

    await importer.import("git@example.com:demo.git", {});

    expect(createSpy).toHaveBeenCalledTimes(1);
    const arg = createSpy.mock.calls[0][0] as { retrievalMeta: unknown };
    expect(arg.retrievalMeta).toEqual({
      triggers: ["search files", "find regex"],
      whenToUse: "Use when the user wants to grep recursively.",
      embeddingText: "ripgrep wrapper; recursive directory pattern search",
    });
  });

  it("passes retrievalMeta=null when none of the three optional fields is present", async () => {
    vi.spyOn(GitSourceResolver.prototype, "resolve").mockResolvedValueOnce(
      buildSkillFiles(`name: legacy-demo
version: 1.0.0
description: Plain skill, no retrieval signals`),
    );

    const { repo, createSpy } = makeSkillRepo();
    const importer = new SkillImporter(
      makeStorage(), repo, makeFileRepo(), makeCache(), makeLogger(),
    );

    await importer.import("git@example.com:legacy.git", {});

    expect(createSpy).toHaveBeenCalledTimes(1);
    const arg = createSpy.mock.calls[0][0] as { retrievalMeta: unknown };
    expect(arg.retrievalMeta).toBeNull();
  });

  it("partial retrieval signals (only triggers) — null fields are not stored as undefined keys", async () => {
    vi.spyOn(GitSourceResolver.prototype, "resolve").mockResolvedValueOnce(
      buildSkillFiles(`name: partial-demo
version: 1.0.0
description: Only triggers
triggers:
  - "alpha"
  - "beta"`),
    );

    const { repo, createSpy } = makeSkillRepo();
    const importer = new SkillImporter(
      makeStorage(), repo, makeFileRepo(), makeCache(), makeLogger(),
    );

    await importer.import("git@example.com:partial.git", {});

    expect(createSpy).toHaveBeenCalledTimes(1);
    const arg = createSpy.mock.calls[0][0] as { retrievalMeta: Record<string, unknown> };
    expect(arg.retrievalMeta).toEqual({ triggers: ["alpha", "beta"] });
    expect(Object.keys(arg.retrievalMeta).sort()).toEqual(["triggers"]);
  });
});
