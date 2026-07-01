import { readFile, writeFile, unlink, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { CacheEntryMeta, ICacheProvider } from "./provider.interface.js";
import { getLogger } from "../utils/logger.js";
import { metrics } from "../telemetry/metrics.js";

const logger = getLogger();

interface FileCacheMeta {
  key: string;
  expires: number | null;
}

export interface FileCacheOptions {
  /**
   * GC sweep interval in ms. Default 10 minutes. `0` or negative disables
   * the timer entirely (used by tests that drive {@link runGc} manually).
   */
  gcIntervalMs?: number;
}

const LAYER = "file";

export class FileCacheProvider implements ICacheProvider {
  private cacheDir: string;
  // T-604 — in-memory key→filenameHash index. Populated lazily (first
  // clearByPrefix after restart pays the full scan once) and incrementally
  // (every set/delete updates it), so steady-state clearByPrefix is
  // O(matched) instead of O(all entries × readFile + JSON.parse).
  private keyIndex = new Map<string, string>();
  private indexReady: Promise<void> | null = null;
  // T-403 — periodic GC. lazy-on-get already evicts entries that the caller
  // happens to read after expiry, but cold keys (e.g. an org who stops
  // calling) would otherwise sit on disk forever. The timer wakes up on a
  // fixed interval, walks the in-memory index, and unlinks any meta whose
  // `expires` is in the past. unref()'d so it never blocks process exit.
  private gcTimer: NodeJS.Timeout | null = null;
  private gcInFlight = false;

  constructor(cacheDir: string = "./data/cache", opts: FileCacheOptions = {}) {
    this.cacheDir = cacheDir;
    if (!existsSync(cacheDir)) {
      mkdir(cacheDir, { recursive: true }).catch(() => {});
    }
    const interval = opts.gcIntervalMs ?? 10 * 60 * 1000;
    if (interval > 0) {
      this.gcTimer = setInterval(() => {
        void this.runGc().catch((err) => {
          logger.warn({ cacheDir: this.cacheDir, error: err }, "FileCacheProvider GC sweep failed");
        });
      }, interval);
      this.gcTimer.unref?.();
    }
  }

  /** Stop the GC timer. Call from graceful-shutdown paths or in tests. */
  stop(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  /**
   * Walk the key index and unlink entries whose `expires` is in the past.
   * Returns the eviction count. Concurrent calls short-circuit (a sweep
   * already running takes the work).
   */
  async runGc(): Promise<number> {
    if (this.gcInFlight) return 0;
    this.gcInFlight = true;
    const stop = metrics.cacheGcDuration.startTimer({ layer: LAYER });
    let evicted = 0;
    try {
      await this.ensureIndex();
      const now = Date.now();
      // Snapshot keys so we can mutate the map while iterating.
      const candidates = Array.from(this.keyIndex.entries());
      for (const [key, hash] of candidates) {
        const metaPath = join(this.cacheDir, `${hash}.meta`);
        try {
          const raw = await readFile(metaPath, "utf-8");
          const meta = JSON.parse(raw) as FileCacheMeta;
          if (meta.expires === null || meta.expires > now) continue;
          const dataPath = join(this.cacheDir, `${hash}.cache`);
          await Promise.all([
            unlink(dataPath).catch(() => undefined),
            unlink(metaPath).catch(() => undefined),
          ]);
          this.keyIndex.delete(key);
          evicted++;
        } catch {
          // Meta unreadable / corrupt — drop the index entry so callers
          // stop trying to use it; orphan .cache (if any) is harmless.
          this.keyIndex.delete(key);
        }
      }
      metrics.cacheGcRuns.inc({ layer: LAYER });
      if (evicted > 0) metrics.cacheGcEvicted.inc({ layer: LAYER }, evicted);
      return evicted;
    } finally {
      stop();
      this.gcInFlight = false;
    }
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexReady) return this.indexReady;
    this.indexReady = (async () => {
      try {
        const entries = await readdir(this.cacheDir);
        const metaFiles = entries.filter((e) => e.endsWith(".meta"));
        await Promise.all(
          metaFiles.map(async (m) => {
            try {
              const meta = JSON.parse(await readFile(join(this.cacheDir, m), "utf-8")) as FileCacheMeta;
              if (typeof meta.key === "string") {
                this.keyIndex.set(meta.key, m.replace(/\.meta$/, ""));
              }
            } catch {
              // Corrupt or partial entry — leave it; clear/clearByPrefix
              // fallback path will eventually clean it up.
            }
          }),
        );
      } catch (e) {
        logger.warn({ cacheDir: this.cacheDir, error: e }, "FileCacheProvider failed to load key index");
      }
    })();
    return this.indexReady;
  }

  private hashKey(key: string): string {
    return createHash("sha256").update(key).digest("hex").slice(0, 32);
  }

  private dataPathFor(key: string): string {
    return join(this.cacheDir, `${this.hashKey(key)}.cache`);
  }

  private metaPathFor(key: string): string {
    return join(this.cacheDir, `${this.hashKey(key)}.meta`);
  }

  async get<T>(key: string): Promise<T | null> {
    const meta = await this.getWithMeta<T>(key);
    return meta ? meta.value : null;
  }

  async getWithMeta<T>(key: string): Promise<CacheEntryMeta<T> | null> {
    const dataPath = this.dataPathFor(key);
    const metaPath = this.metaPathFor(key);

    try {
      const metaContent = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(metaContent) as FileCacheMeta;
      if (meta.key !== key) return null; // hash collision guard
      if (meta.expires !== null && Date.now() > meta.expires) {
        await this.delete(key);
        return null;
      }

      const content = await readFile(dataPath, "utf-8");
      return { value: JSON.parse(content) as T, expiresAt: meta.expires };
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const dataPath = this.dataPathFor(key);
    const metaPath = this.metaPathFor(key);
    const expires = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    const meta: FileCacheMeta = { key, expires };

    await writeFile(dataPath, JSON.stringify(value), "utf-8");
    await writeFile(metaPath, JSON.stringify(meta), "utf-8");
    this.keyIndex.set(key, this.hashKey(key));
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    const dataPath = this.dataPathFor(key);
    const metaPath = this.metaPathFor(key);
    try { await unlink(dataPath); } catch (e) { logger.debug({ key, error: e }, "Failed to delete cache data file"); }
    try { await unlink(metaPath); } catch (e) { logger.debug({ key, error: e }, "Failed to delete cache meta file"); }
    this.keyIndex.delete(key);
  }

  async clear(): Promise<void> {
    try {
      const entries = await readdir(this.cacheDir);
      await Promise.all(
        entries
          .filter(e => e.endsWith(".cache") || e.endsWith(".meta"))
          .map(e => unlink(join(this.cacheDir, e)).catch((err) => {
            logger.debug({ file: e, error: err }, "Failed to delete cache file during clear");
          }))
      );
    } catch (e) {
      logger.warn({ cacheDir: this.cacheDir, error: e }, "Failed to clear file cache");
    }
    this.keyIndex.clear();
  }

  async clearByPrefix(prefix: string): Promise<void> {
    try {
      await this.ensureIndex();
      const matched: string[] = [];
      for (const key of this.keyIndex.keys()) {
        if (key.startsWith(prefix)) matched.push(key);
      }
      await Promise.all(matched.map((key) => {
        const hash = this.keyIndex.get(key);
        this.keyIndex.delete(key);
        if (!hash) return Promise.resolve();
        const dataPath = join(this.cacheDir, `${hash}.cache`);
        const metaPath = join(this.cacheDir, `${hash}.meta`);
        return Promise.all([
          unlink(dataPath).catch(() => {}),
          unlink(metaPath).catch(() => {}),
        ]).then(() => undefined);
      }));
    } catch (e) {
      logger.warn({ prefix, error: e }, "Failed to clear file cache by prefix");
    }
  }
}
