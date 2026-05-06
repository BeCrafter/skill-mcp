import { describe, it, expect, vi } from "vitest";
import { SkillService } from "../../../src/services/skill.service.js";
import type { ISkillProvider } from "../../../src/provider/interface.js";
import type { ICacheProvider } from "../../../src/cache/provider.interface.js";
import type { IPermissionFilter } from "../../../src/permission/filter.interface.js";
import type { Logger } from "pino";
import type { SkillMeta, SkillFileContent, FileInfo } from "../../../src/types/index.js";

const sampleSkill: SkillMeta = {
  id: "1", slug: "test-skill", name: "test-skill",
  displayName: null, description: "A test skill for testing",
  version: "0.0.1", category: null, tags: [], attributes: {},
  status: "published", visibility: "public", entryFile: "SKILL.md",
  storagePath: "skills/test/", contentHash: null,
  conditions: null, assignedGroups: [], createdAt: 1, updatedAt: 1,
};

function createMockProvider(overrides?: Partial<ISkillProvider>): ISkillProvider {
  return {
    listSkills: vi.fn().mockResolvedValue([]),
    getSkillMeta: vi.fn().mockResolvedValue(sampleSkill),
    getSkillEntry: vi.fn().mockResolvedValue("# Test Skill\n\nSome content"),
    getSkillFiles: vi.fn().mockResolvedValue([]),
    getSkillFileTree: vi.fn().mockResolvedValue([]),
    skillExists: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function createMockCache(): ICacheProvider {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    delete: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    clearByPrefix: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockFilter(): IPermissionFilter {
  return {
    filter: vi.fn().mockImplementation((skills) => Promise.resolve(skills)),
    check: vi.fn().mockResolvedValue(true),
  };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
  } as unknown as Logger;
}

describe("SkillService", () => {
  const mockLogger = createMockLogger();
  const mockCache = createMockCache();
  const mockFilter = createMockFilter();

  it("should list skills index as flat text", async () => {
    const skills: SkillMeta[] = [
      sampleSkill,
      {
        id: "2", slug: "draft-skill", name: "draft-skill",
        displayName: null, description: "A draft",
        version: "0.0.1", category: null, tags: [], attributes: {},
        status: "draft", visibility: "public", entryFile: "SKILL.md",
        storagePath: "skills/draft/", contentHash: null,
        conditions: null, assignedGroups: [], createdAt: 1, updatedAt: 1,
      },
    ];

    const provider = createMockProvider({ listSkills: vi.fn().mockResolvedValue(skills) });
    const service = new SkillService(provider, mockCache, mockFilter, mockLogger);

    const index = await service.listSkillsIndex();
    expect(index).toContain("test-skill");
    expect(index).toContain("A test skill for testing");
    expect(index).not.toContain("draft-skill");
    expect(index).toContain("    - test-skill [id:"); // indented flat list with id
  });

  it("should view skill entry with activation guidance", async () => {
    const entryContent = "# Prompt Writer\n\n## Trigger\nWrite prompts";
    const fileTree: FileInfo[] = [
      { path: "references/framework.md", type: "file", size: 100, mimeType: "text/markdown" },
      { path: "templates/checklist.md", type: "file", size: 50, mimeType: "text/markdown" },
    ];

    const provider = createMockProvider({
      getSkillMeta: vi.fn().mockResolvedValue({ ...sampleSkill, slug: "prompt-writer" }),
      getSkillEntry: vi.fn().mockResolvedValue(entryContent),
      getSkillFileTree: vi.fn().mockResolvedValue(fileTree),
    });
    const service = new SkillService(provider, mockCache, mockFilter, mockLogger);

    const result = await service.viewSkillEntry("prompt-writer");
    expect(result).toContain("prompt-writer");
    expect(result).toContain("# Prompt Writer");
    expect(result).toContain("[Available files:");
    expect(result).toContain("references/framework.md");
    expect(result).toContain("[Tip: Use skill_file(");
  });

  it("should read skill files in batch", async () => {
    const files: SkillFileContent[] = [
      { path: "references/a.md", content: "content a", encoding: "utf-8" },
      { path: "templates/b.md", content: "content b", encoding: "utf-8" },
    ];
    const provider = createMockProvider({
      getSkillFiles: vi.fn().mockResolvedValue(files),
    });
    const service = new SkillService(provider, mockCache, mockFilter, mockLogger);

    const result = await service.readSkillFiles("test-skill", ["references/a.md", "templates/b.md"]);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("content a");
    expect(provider.getSkillFiles).toHaveBeenCalledWith("test-skill", ["references/a.md", "templates/b.md"]);
  });

  it("should check skill existence", async () => {
    const provider = createMockProvider({ skillExists: vi.fn().mockResolvedValue(true) });
    const service = new SkillService(provider, mockCache, mockFilter, mockLogger);

    expect(await service.skillExists("test-skill")).toBe(true);
  });

  it("should return empty index for no skills", async () => {
    const provider = createMockProvider({ listSkills: vi.fn().mockResolvedValue([]) });
    const service = new SkillService(provider, mockCache, mockFilter, mockLogger);

    const index = await service.listSkillsIndex();
    expect(index).toBe("");
  });

  it("should throw SkillNotFoundError when viewing non-existent skill", async () => {
    const provider = createMockProvider({ getSkillMeta: vi.fn().mockResolvedValue(null) });
    const service = new SkillService(provider, mockCache, mockFilter, mockLogger);

    await expect(service.viewSkillEntry("nonexistent")).rejects.toThrow("Skill not found");
  });

  it("should throw PermissionDeniedError when permission denied", async () => {
    const provider = createMockProvider();
    const denyFilter: IPermissionFilter = {
      filter: vi.fn().mockImplementation((skills) => Promise.resolve(skills)),
      check: vi.fn().mockResolvedValue(false),
    };
    const service = new SkillService(provider, mockCache, denyFilter, mockLogger);

    await expect(service.viewSkillEntry("test-skill")).rejects.toThrow("Permission denied");
    await expect(service.readSkillFiles("test-skill", ["a.md"])).rejects.toThrow("Permission denied");
  });
});
