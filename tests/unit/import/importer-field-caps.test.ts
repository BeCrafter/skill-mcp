import { describe, it, expect, vi } from "vitest";
import { SkillImporter } from "../../../src/import/importer.js";
import { GitSourceResolver } from "../../../src/import/git-source.js";
import type { IStorageProvider } from "../../../src/storage/provider.interface.js";
import type { ICacheProvider } from "../../../src/cache/provider.interface.js";
import type { SkillRepository } from "../../../src/db/repositories/skill.repository.js";
import type { SkillFileRepository } from "../../../src/db/repositories/skill-file.repository.js";
import type { Logger } from "pino";

/**
 * T-722 — git/http import path must enforce T-705 frontmatter caps. The
 * local-fs path delegates to `validateSkillMeta(meta, dirPath)`; the git/http
 * branch parses frontmatter directly from in-memory buffers and previously
 * skipped every cap check, letting a malicious repo push multi-MB strings
 * and non-string tags through the importer.
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

function makeSkillRepo(): SkillRepository {
  return {
    findByName: vi.fn().mockResolvedValue([]),
    findBySlug: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    findByNameAndHash: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: "new-id", slug: "demo" }),
    update: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
  } as unknown as SkillRepository;
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

describe("SkillImporter T-722 — git/http frontmatter caps", () => {
  it("rejects oversized description from a git source", async () => {
    const oversizedDescription = "d".repeat(4097);
    vi.spyOn(GitSourceResolver.prototype, "resolve").mockResolvedValueOnce(
      buildSkillFiles(`name: demo\nversion: 1.0.0\ndescription: ${oversizedDescription}`),
    );

    const importer = new SkillImporter(
      makeStorage(), makeSkillRepo(), makeFileRepo(), makeCache(), makeLogger(),
    );

    await expect(importer.import("git@example.com:demo.git", {})).rejects.toThrow(/description exceeds max length/);
  });

  it("rejects too many tags from an http source", async () => {
    const tags = Array.from({ length: 65 }, (_, i) => `t${i}`).join(", ");
    vi.spyOn(GitSourceResolver.prototype, "resolve").mockResolvedValueOnce(
      buildSkillFiles(`name: demo\nversion: 1.0.0\ntags: [${tags}]`),
    );

    const importer = new SkillImporter(
      makeStorage(), makeSkillRepo(), makeFileRepo(), makeCache(), makeLogger(),
    );

    await expect(importer.import("https://example.com/repo.git", {})).rejects.toThrow(/tags exceed max count/);
  });

  it("rejects non-array tags from a git source", async () => {
    vi.spyOn(GitSourceResolver.prototype, "resolve").mockResolvedValueOnce(
      buildSkillFiles(`name: demo\nversion: 1.0.0\ntags: not-an-array`),
    );

    const importer = new SkillImporter(
      makeStorage(), makeSkillRepo(), makeFileRepo(), makeCache(), makeLogger(),
    );

    await expect(importer.import("git@example.com:demo.git", {})).rejects.toThrow(/tags must be an array/);
  });
});
