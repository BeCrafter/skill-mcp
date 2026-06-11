import type { CacheEntryMeta, ICacheProvider } from "./provider.interface.js";
import { MemoryLRUCacheProvider } from "./memory-lru.provider.js";
import { FileCacheProvider } from "./file.provider.js";
import { metrics } from "../telemetry/metrics.js";
import { withSpan } from "../telemetry/spans.js";

export class CompositeCacheProvider implements ICacheProvider {
  private l1: ICacheProvider;
  private l2: ICacheProvider;
  private l2TtlMultiplier: number;

  constructor(options: {
    memory?: { enabled: boolean; maxSize: number };
    file?: { enabled: boolean; cacheDir: string };
    l2TtlMultiplier?: number;
  } = {}) {
    const memOpts = options.memory ?? { enabled: true, maxSize: 500 };
    const fileOpts = options.file ?? { enabled: true, cacheDir: "./data/cache" };
    this.l2TtlMultiplier = options.l2TtlMultiplier ?? 2;

    this.l1 = memOpts.enabled
      ? new MemoryLRUCacheProvider(memOpts.maxSize)
      : new NoopCacheProvider();
    this.l2 = fileOpts.enabled
      ? new FileCacheProvider(fileOpts.cacheDir)
      : new NoopCacheProvider();
  }

  async get<T>(key: string): Promise<T | null> {
    const meta = await this.getWithMeta<T>(key);
    return meta ? meta.value : null;
  }

  async getWithMeta<T>(key: string): Promise<CacheEntryMeta<T> | null> {
    // P0-6 — emit one span per cache layer (§17.6: `cache.l1.get` / `cache.l2.get`).
    // We tag with `cache.key` and the hit/miss result; cardinality is bounded
    // by the deterministic key shape (`skill:list:{userId}:gN:uM`).
    const l1Meta = await withSpan("cache.l1.get", { attributes: { "cache.key": key } }, () => this.l1.getWithMeta<T>(key));
    if (l1Meta !== null) {
      metrics.cacheOps.inc({ layer: "l1", result: "hit" });
      return l1Meta;
    }
    metrics.cacheOps.inc({ layer: "l1", result: "miss" });

    const l2Meta = await withSpan("cache.l2.get", { attributes: { "cache.key": key } }, () => this.l2.getWithMeta<T>(key));
    if (l2Meta !== null) {
      metrics.cacheOps.inc({ layer: "l2", result: "hit" });
      // Promote to L1, preserving the L2 entry's remaining TTL so the L1
      // copy expires no later than its L2 counterpart.
      const remainingSeconds = l2Meta.expiresAt
        ? Math.max(1, Math.ceil((l2Meta.expiresAt - Date.now()) / 1000))
        : undefined;
      await this.l1.set(key, l2Meta.value, remainingSeconds);
      return l2Meta;
    }
    metrics.cacheOps.inc({ layer: "l2", result: "miss" });

    return null;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.l1.set(key, value, ttlSeconds);
    if (ttlSeconds) {
      await this.l2.set(key, value, ttlSeconds * this.l2TtlMultiplier);
    } else {
      await this.l2.set(key, value);
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    await Promise.all([this.l1.delete(key), this.l2.delete(key)]);
  }

  async clear(): Promise<void> {
    await Promise.all([this.l1.clear(), this.l2.clear()]);
  }

  async clearByPrefix(prefix: string): Promise<void> {
    await Promise.all([this.l1.clearByPrefix(prefix), this.l2.clearByPrefix(prefix)]);
  }
}

/** No-op cache for when caching is disabled */
class NoopCacheProvider implements ICacheProvider {
  async get<T>(): Promise<T | null> { return null; }
  async getWithMeta<T>(): Promise<CacheEntryMeta<T> | null> { return null; }
  async set(): Promise<void> {}
  async has(): Promise<boolean> { return false; }
  async delete(): Promise<void> {}
  async clear(): Promise<void> {}
  async clearByPrefix(): Promise<void> {}
}
