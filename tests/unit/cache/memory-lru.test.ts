import { describe, it, expect, beforeEach } from "vitest";
import { MemoryLRUCacheProvider } from "../../../src/cache/memory-lru.provider.js";

describe("MemoryLRUCacheProvider", () => {
  let cache: MemoryLRUCacheProvider;

  beforeEach(() => {
    cache = new MemoryLRUCacheProvider(3);
  });

  it("should store and retrieve values", async () => {
    await cache.set("key1", "value1");
    expect(await cache.get("key1")).toBe("value1");
  });

  it("should return null for missing keys", async () => {
    expect(await cache.get("missing")).toBeNull();
  });

  it("should evict oldest entries when full", async () => {
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.set("c", 3);
    await cache.set("d", 4); // evicts "a"
    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("d")).toBe(4);
  });

  it("should respect TTL", async () => {
    await cache.set("ttl-key", "value", 0.01); // 10ms TTL
    await new Promise((r) => setTimeout(r, 50));
    expect(await cache.get("ttl-key")).toBeNull();
  });

  it("should clear all entries", async () => {
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.clear();
    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("b")).toBeNull();
  });

  it("should delete individual entries", async () => {
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.delete("a");
    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("b")).toBe(2);
  });

  it("should check if key exists", async () => {
    await cache.set("exists", true);
    expect(await cache.has("exists")).toBe(true);
    expect(await cache.has("nope")).toBe(false);
  });

  it("should clearByPrefix matching keys only", async () => {
    await cache.set("skill:entry:my-skill", "content");
    await cache.set("skill:file:my-skill", "file");
    await cache.set("skill:entry:other-skill", "other");
    await cache.set("unrelated:key", "value");

    await cache.clearByPrefix("skill:entry:my-skill");

    expect(await cache.get("skill:entry:my-skill")).toBeNull();
    expect(await cache.get("skill:file:my-skill")).toBe("file");
    expect(await cache.get("skill:entry:other-skill")).toBe("other");
    expect(await cache.get("unrelated:key")).toBe("value");
  });

  it("should update value on re-set of existing key", async () => {
    await cache.set("key", "v1");
    await cache.set("key", "v2");
    expect(await cache.get("key")).toBe("v2");
  });
});
