import type { ICacheProvider } from "./provider.interface.js";
import { MemoryLRUCacheProvider } from "./memory-lru.provider.js";
import { FileCacheProvider } from "./file.provider.js";
import { metrics } from "../telemetry/metrics.js";

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
    // L1 → L2
    const l1Value = await this.l1.get<T>(key);
    if (l1Value !== null) {
      metrics.cacheOps.inc({ layer: "l1", result: "hit" });
      return l1Value;
    }
    metrics.cacheOps.inc({ layer: "l1", result: "miss" });

    const l2Value = await this.l2.get<T>(key);
    if (l2Value !== null) {
      metrics.cacheOps.inc({ layer: "l2", result: "hit" });
      // Promote to L1
      await this.l1.set(key, l2Value);
      return l2Value;
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
  async set(): Promise<void> {}
  async has(): Promise<boolean> { return false; }
  async delete(): Promise<void> {}
  async clear(): Promise<void> {}
  async clearByPrefix(): Promise<void> {}
}
