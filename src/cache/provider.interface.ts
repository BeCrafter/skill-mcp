export interface CacheEntryMeta<T> {
  value: T;
  /** Absolute expiry timestamp in ms; null means no expiry. */
  expiresAt: number | null;
}

export interface ICacheProvider {
  /** Get a cached value */
  get<T>(key: string): Promise<T | null>;

  /** Get a cached value together with its absolute expiry timestamp. */
  getWithMeta<T>(key: string): Promise<CacheEntryMeta<T> | null>;

  /** Set a cached value with optional TTL in seconds */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  /** Check if a key exists */
  has(key: string): Promise<boolean>;

  /** Delete a key */
  delete(key: string): Promise<void>;

  /** Clear all cache entries */
  clear(): Promise<void>;

  /** Clear cache entries matching a prefix (e.g. "skill:entry:my-skill") */
  clearByPrefix(prefix: string): Promise<void>;
}
