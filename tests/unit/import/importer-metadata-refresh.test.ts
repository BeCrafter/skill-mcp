import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillImporter } from "../../../src/import/importer.js";
import { computeContentHash } from "../../../src/utils/manifest.js";
import type { IStorageProvider } from "../../../src/storage/provider.interface.js";
import type { ICacheProvider } from "../../../src/cache/provider.interface.js";
import type { SkillRepository } from "../../../src/db/repositories/skill.repository.js";
import type { SkillFileRepository } from "../../../src/db/repositories/skill-file.repository.js";
import type { Logger } from "pino";
import type { SkillMeta } from "../../../src/types/index.js";

/**
 * releases/v0.1.md 契约 #2 — 导入成功返回前必须等待对应 Skill 的索引刷新。
 * 两条"内容未变、仅元数据更新"早返回分支（targetId / overwrite）原先仅靠
 * 事件总线 fire-and-forget 收敛，不保证 `skill_search` 在 `import()` 返回时已反映
 * 新的 description/triggers/when_to_use/embedding_text 或 tags 可见性。这里用
 * 可控的 deferred onMutation 验证它确被 `await`，而非 fire-and-forget。
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

function makeFileRepo(): SkillFileRepository {
  return {
    deleteBySkillId: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    replaceAll: vi.fn().mockResolvedValue(undefined),
    findBySkillId: vi.fn().mockResolvedValue([]),
  } as unknown as SkillFileRepository;
}

function existingSkill(contentHash: string): SkillMeta {
  return {
    id: "skill-1", slug: "demo", name: "demo", displayName: null,
    description: "original", version: "1.0.0", category: null, tags: [],
    attributes: {}, status: "published", visibility: "public",
    entryFile: "SKILL.md", storagePath: "demo/", contentHash,
    createdAt: 0, updatedAt: 0,
  };
}

/** A controllable onMutation that only resolves when `resolve()` is called. */
function deferredOnMutation() {
  let resolve!: () => void;
  const started = vi.fn();
  const promise = new Promise<void>((res) => { resolve = res; });
  const fn = vi.fn().mockImplementation(() => { started(); return promise; });
  return { fn, started, resolve };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "importer-meta-refresh-"));
  writeFileSync(join(tmpDir, "SKILL.md"), [
    "---",
    "name: demo",
    "version: 1.0.0",
    "description: original",
    "---",
    "",
    "# Demo",
    "Body.",
  ].join("\n"));
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

/** Flush pending microtasks (incl. import's own awaits) without awaiting the import itself. */
function flushMicrotasks() {
  return new Promise<void>((r) => setImmediate(r));
}

describe("SkillImporter — metadata-only import awaits index refresh (FAST_RELEASE contract #2)", () => {
  it("targetId path: content unchanged + description changed awaits onMutation before returning", async () => {
    const buffer = readFileSync(join(tmpDir, "SKILL.md"));
    const contentHash = computeContentHash([{ path: "SKILL.md", buffer }]);
    const refresh = deferredOnMutation();
    const updateSpy = vi.fn().mockResolvedValue(null);
    const skillRepo = {
      findByName: vi.fn().mockResolvedValue([]),
      findBySlug: vi.fn().mockResolvedValue({ ...existingSkill(contentHash), description: "new description" }),
      findById: vi.fn().mockResolvedValue(existingSkill(contentHash)),
      findByNameAndHash: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "new-id", slug: "demo" } as SkillMeta),
      update: updateSpy,
      delete: vi.fn().mockResolvedValue(true),
    } as unknown as SkillRepository;

    const importer = new SkillImporter(
      makeStorage(), skillRepo, makeFileRepo(), makeCache(), makeLogger(),
      undefined, undefined, true, refresh.fn,
    );

    const importPromise = importer.import(tmpDir, { targetId: "skill-1", description: "new description" });
    let importResolved = false;
    importPromise.then(() => { importResolved = true; });

    // Let the importer reach the onMutation call.
    await flushMicrotasks();
    expect(refresh.started).toHaveBeenCalledTimes(1);
    expect(refresh.fn).toHaveBeenCalledWith("demo");
    // onMutation is awaited: import must NOT resolve until refresh resolves.
    expect(importResolved).toBe(false);

    refresh.resolve();
    const result = await importPromise;
    expect(result.action).toBe("updated");
    expect(updateSpy).toHaveBeenCalledWith("skill-1", expect.objectContaining({ description: "new description" }));
  });

  it("overwrite path: content unchanged + description changed awaits onMutation before returning", async () => {
    const buffer = readFileSync(join(tmpDir, "SKILL.md"));
    const contentHash = computeContentHash([{ path: "SKILL.md", buffer }]);
    const refresh = deferredOnMutation();
    const updateSpy = vi.fn().mockResolvedValue(null);
    const skillRepo = {
      findByName: vi.fn().mockResolvedValue([existingSkill(contentHash)]),
      findBySlug: vi.fn().mockResolvedValue({ ...existingSkill(contentHash), description: "new description" }),
      findById: vi.fn().mockResolvedValue(null),
      findByNameAndHash: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "new-id", slug: "demo" } as SkillMeta),
      update: updateSpy,
      delete: vi.fn().mockResolvedValue(true),
    } as unknown as SkillRepository;

    const importer = new SkillImporter(
      makeStorage(), skillRepo, makeFileRepo(), makeCache(), makeLogger(),
      undefined, undefined, true, refresh.fn,
    );

    const importPromise = importer.import(tmpDir, { overwrite: true, description: "new description" });
    let importResolved = false;
    importPromise.then(() => { importResolved = true; });

    await flushMicrotasks();
    expect(refresh.started).toHaveBeenCalledTimes(1);
    expect(refresh.fn).toHaveBeenCalledWith("demo");
    expect(importResolved).toBe(false);

    refresh.resolve();
    const result = await importPromise;
    expect(result.action).toBe("updated");
    expect(updateSpy).toHaveBeenCalledWith("skill-1", expect.objectContaining({ description: "new description" }));
  });
});
