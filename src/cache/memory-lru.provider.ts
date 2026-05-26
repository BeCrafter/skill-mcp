import type { CacheEntryMeta, ICacheProvider } from "./provider.interface.js";

export class MemoryLRUCacheProvider implements ICacheProvider {
  private cache = new Map<string, { value: unknown; expires: number | null }>();
  private maxSize: number;

  constructor(maxSize: number = 500) {
    this.maxSize = maxSize;
  }

  async get<T>(key: string): Promise<T | null> {
    const meta = await this.getWithMeta<T>(key);
    return meta ? meta.value : null;
  }

  async getWithMeta<T>(key: string): Promise<CacheEntryMeta<T> | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expires !== null && Date.now() > entry.expires) {
      this.cache.delete(key);
      return null;
    }
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return { value: entry.value as T, expiresAt: entry.expires };
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    const expires = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    this.cache.delete(key);
    this.cache.set(key, { value, expires });
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  async clearByPrefix(prefix: string): Promise<void> {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }
}
