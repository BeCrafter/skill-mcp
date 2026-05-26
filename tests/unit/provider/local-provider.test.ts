import { describe, it, expect, vi, beforeEach } from "vitest";
import { LocalSkillProvider } from "@/provider/local.provider.js";
import { SkillNotFoundError } from "@/utils/errors.js";
import type { IStorageProvider } from "@/storage/provider.interface.js";
import type { ICacheProvider } from "@/cache/provider.interface.js";
import type { SkillRepository } from "@/db/repositories/skill.repository.js";
import type { SkillFileRepository } from "@/db/repositories/skill-file.repository.js";

function makeSkill(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1", slug: "demo", name: "demo", displayName: null, description: "",
    version: "1", category: null, tags: [], attributes: {}, status: "published",
    visibility: "private", entryFile: "SKILL.md", storagePath: "demo/",
    contentHash: "h", createdAt: 1, updatedAt: 1, ...overrides,
  };
}

function setup() {
  const storeMap = new Map<string, Buffer>();
  const storage: IStorageProvider = {
    get: vi.fn(async (path: string) => storeMap.get(path) ?? null),
    listRecursive: vi.fn(async (prefix: string) =>
      [...storeMap.keys()].filter(k => k.startsWith(prefix)),
    ),
    size: vi.fn(async (path: string) => storeMap.get(path)?.length ?? 0),
    put: vi.fn(),
    delete: vi.fn(),
    deleteDir: vi.fn(),
    exists: vi.fn(),
    list: vi.fn(),
  } as unknown as IStorageProvider;

  const cacheStore = new Map<string, unknown>();
  const cache: ICacheProvider = {
    get: vi.fn(async (k: string) => cacheStore.get(k) ?? null),
    set: vi.fn(async (k: string, v: unknown) => { cacheStore.set(k, v); }),
    delete: vi.fn(),
    clear: vi.fn(),
  } as unknown as ICacheProvider;

  const skillRepo = {
    findAll: vi.fn().mockResolvedValue([makeSkill()]),
    findBySlug: vi.fn(async (slug: string) => slug === "demo" ? makeSkill() : null),
    findById: vi.fn(async (id: string) => id === "s1" ? makeSkill() : null),
    exists: vi.fn(async (slug: string) => slug === "demo"),
  } as unknown as SkillRepository;

  const skillFileRepo = {
    findBySkillId: vi.fn().mockResolvedValue([]),
  } as unknown as SkillFileRepository;

  const provider = new LocalSkillProvider(storage, skillRepo, skillFileRepo, cache);
  return { provider, storage, cache, skillRepo, skillFileRepo, storeMap, cacheStore };
}

describe("LocalSkillProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("listSkills filters to published and forwards category/tags", async () => {
    const { provider, skillRepo } = setup();
    await provider.listSkills({ category: "ai", tags: ["t"] });
    expect(skillRepo.findAll).toHaveBeenCalledWith({
      status: "published", category: "ai", tags: ["t"],
    });
  });

  it("getSkillMeta / getSkillMetaById delegate to repo", async () => {
    const { provider, skillRepo } = setup();
    await provider.getSkillMeta("demo");
    expect(skillRepo.findBySlug).toHaveBeenCalledWith("demo");
    await provider.getSkillMetaById("s1");
    expect(skillRepo.findById).toHaveBeenCalledWith("s1");
  });

  it("skillExists returns repo.exists result", async () => {
    const { provider } = setup();
    await expect(provider.skillExists("demo")).resolves.toBe(true);
    await expect(provider.skillExists("nope")).resolves.toBe(false);
  });

  it("getSkillEntry throws SkillNotFoundError for unknown slug", async () => {
    const { provider } = setup();
    await expect(provider.getSkillEntry("nope")).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("getSkillEntry caches storage reads", async () => {
    const { provider, storage, storeMap, cache } = setup();
    storeMap.set("demo/SKILL.md", Buffer.from("# hello"));

    expect(await provider.getSkillEntry("demo")).toBe("# hello");
    expect(storage.get).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith("skill:entry:demo", "# hello", 600);

    expect(await provider.getSkillEntry("demo")).toBe("# hello");
    expect(storage.get).toHaveBeenCalledTimes(1);
  });

  it("getSkillEntry throws when storage returns null", async () => {
    const { provider } = setup();
    await expect(provider.getSkillEntry("demo")).rejects.toThrow(/Entry file not found/);
  });

  it("getSkillFiles returns utf-8 for text and base64 for binary, with mime", async () => {
    const { provider, storeMap } = setup();
    storeMap.set("demo/notes.md", Buffer.from("hi"));
    storeMap.set("demo/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const out = await provider.getSkillFiles("demo", ["notes.md", "logo.png"]);
    const md = out.find(f => f.path === "notes.md")!;
    const png = out.find(f => f.path === "logo.png")!;
    expect(md.encoding).toBe("utf-8");
    expect(md.content).toBe("hi");
    expect(png.encoding).toBe("base64");
    expect(png.mimeType).toBe("image/png");
  });

  it("getSkillFiles caches text files only", async () => {
    const { provider, cache, storeMap } = setup();
    storeMap.set("demo/a.md", Buffer.from("text"));
    storeMap.set("demo/b.bin", Buffer.from([0xde, 0xad]));

    await provider.getSkillFiles("demo", ["a.md", "b.bin"]);
    const setCalls = (cache.set as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(setCalls.some(c => String(c[0]).includes("a.md"))).toBe(true);
    expect(setCalls.some(c => String(c[0]).includes("b.bin"))).toBe(false);
  });

  it("getSkillFiles throws SkillNotFoundError on unknown slug", async () => {
    const { provider } = setup();
    await expect(provider.getSkillFiles("nope", ["a.md"])).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("getSkillFiles rejects when a path is missing in storage", async () => {
    const { provider } = setup();
    await expect(provider.getSkillFiles("demo", ["missing.md"])).rejects.toThrow(/File not found/);
  });

  it("getSkillFiles rejects directory-traversal paths via validateFilePath", async () => {
    const { provider } = setup();
    await expect(provider.getSkillFiles("demo", ["../etc/passwd"])).rejects.toThrow();
  });

  it("getSkillFileTree returns DB rows when present", async () => {
    const { provider, skillFileRepo } = setup();
    (skillFileRepo.findBySkillId as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue([{ filePath: "a.md", fileSize: 10, mimeType: "text/markdown" }]);
    const tree = await provider.getSkillFileTree("demo");
    expect(tree).toEqual([{ path: "a.md", type: "file", size: 10, mimeType: "text/markdown" }]);
  });

  it("getSkillFileTree falls back to walking storage when DB is empty", async () => {
    const { provider, storeMap } = setup();
    storeMap.set("demo/SKILL.md", Buffer.from("x"));
    storeMap.set("demo/refs/notes.md", Buffer.from("y"));
    const tree = await provider.getSkillFileTree("demo");
    const paths = tree.map(t => t.path).sort();
    expect(paths).toEqual(["SKILL.md", "refs/notes.md"]);
  });

  it("getSkillFileTree throws SkillNotFoundError on unknown slug", async () => {
    const { provider } = setup();
    await expect(provider.getSkillFileTree("nope")).rejects.toBeInstanceOf(SkillNotFoundError);
  });
});
