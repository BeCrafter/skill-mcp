import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCacheProvider } from "@/cache/file.provider.js";

describe("FileCacheProvider — delete/has/clear surface", () => {
  let dir: string;
  let cache: FileCacheProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-mcp-cache-"));
    cache = new FileCacheProvider(dir);
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it("has() returns true for hit, false after delete", async () => {
    await cache.set("k", "v", 60);
    expect(await cache.has("k")).toBe(true);
    await cache.delete("k");
    expect(await cache.has("k")).toBe(false);
  });

  it("delete() is a no-op for missing key (no throw)", async () => {
    await expect(cache.delete("never")).resolves.not.toThrow();
  });

  it("clear() removes only .cache + .meta files and leaves siblings alone", async () => {
    await cache.set("k1", "a", 60);
    await cache.set("k2", "b", 60);
    // Drop a non-cache sibling that clear() must leave untouched.
    writeFileSync(join(dir, "keep.txt"), "do not delete");

    await cache.clear();
    const left = readdirSync(dir);
    expect(left).toContain("keep.txt");
    expect(left.some(f => f.endsWith(".cache") || f.endsWith(".meta"))).toBe(false);
    expect(await cache.has("k1")).toBe(false);
  });

  it("clear() on already-empty directory does not throw", async () => {
    await expect(cache.clear()).resolves.not.toThrow();
  });

  it("clearByPrefix removes only matching keys", async () => {
    await cache.set("skill:a:1", "x", 60);
    await cache.set("skill:b:2", "y", 60);
    await cache.set("other:c", "z", 60);
    await cache.clearByPrefix("skill:");
    expect(await cache.has("skill:a:1")).toBe(false);
    expect(await cache.has("skill:b:2")).toBe(false);
    expect(await cache.has("other:c")).toBe(true);
  });

  it("clearByPrefix on a missing prefix is a silent no-op", async () => {
    await cache.set("a:1", "v", 60);
    await cache.clearByPrefix("nomatch:");
    expect(await cache.has("a:1")).toBe(true);
  });
});
