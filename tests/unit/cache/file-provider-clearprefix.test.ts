import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCacheProvider } from "@/cache/file.provider.js";

describe("FileCacheProvider clearByPrefix (T-604)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-mcp-fc-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes only entries whose key starts with the prefix", async () => {
    const cache = new FileCacheProvider(dir);
    await cache.set("skill:meta:demo", { a: 1 });
    await cache.set("skill:meta:other", { b: 2 });
    await cache.set("user:1", { c: 3 });

    await cache.clearByPrefix("skill:meta:");

    expect(await cache.get("skill:meta:demo")).toBeNull();
    expect(await cache.get("skill:meta:other")).toBeNull();
    expect(await cache.get("user:1")).toEqual({ c: 3 });
  });

  it("ensureIndex picks up entries written before construction", async () => {
    const old = new FileCacheProvider(dir);
    await old.set("skill:entry:legacy", "hello");
    await old.set("user:keep", "kept");

    // Simulate process restart — fresh provider, empty in-memory index.
    const fresh = new FileCacheProvider(dir);
    await fresh.clearByPrefix("skill:");

    expect(await fresh.get("skill:entry:legacy")).toBeNull();
    expect(await fresh.get("user:keep")).toBe("kept");
  });

  it("set/delete maintain the in-memory index incrementally", async () => {
    const cache = new FileCacheProvider(dir);
    await cache.set("skill:files:a", [1, 2]);
    await cache.set("skill:files:b", [3, 4]);
    await cache.delete("skill:files:a");
    await cache.clearByPrefix("skill:files:");

    const remaining = readdirSync(dir).filter((f) => f.endsWith(".cache") || f.endsWith(".meta"));
    expect(remaining).toEqual([]);
  });

  it("survives a corrupt meta file during ensureIndex", async () => {
    writeFileSync(join(dir, "deadbeef.meta"), "{not json", "utf-8");
    const cache = new FileCacheProvider(dir);
    await cache.set("skill:ok", "v");

    await expect(cache.clearByPrefix("skill:")).resolves.toBeUndefined();
    expect(await cache.get("skill:ok")).toBeNull();
  });
});
