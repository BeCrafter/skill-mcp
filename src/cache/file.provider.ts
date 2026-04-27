import { readFile, writeFile, unlink, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ICacheProvider } from "./provider.interface.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger();

export class FileCacheProvider implements ICacheProvider {
  private cacheDir: string;

  constructor(cacheDir: string = "./data/cache") {
    this.cacheDir = cacheDir;
    if (!existsSync(cacheDir)) {
      mkdir(cacheDir, { recursive: true }).catch(() => {});
    }
  }

  private keyToPath(key: string): string {
    // Replace colons and other chars for safe filenames
    const safe = key.replace(/[:/\\*?"<>|]/g, "_");
    return join(this.cacheDir, `${safe}.cache`);
  }

  private getMetaPath(dataPath: string): string {
    return dataPath.replace(".cache", ".meta");
  }

  async get<T>(key: string): Promise<T | null> {
    const dataPath = this.keyToPath(key);
    const metaPath = this.getMetaPath(dataPath);

    try {
      const metaContent = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(metaContent);
      if (meta.expires !== null && Date.now() > meta.expires) {
        await this.delete(key);
        return null;
      }

      const content = await readFile(dataPath, "utf-8");
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const dataPath = this.keyToPath(key);
    const metaPath = this.getMetaPath(dataPath);
    const expires = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;

    await writeFile(dataPath, JSON.stringify(value), "utf-8");
    await writeFile(metaPath, JSON.stringify({ expires }), "utf-8");
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    const dataPath = this.keyToPath(key);
    const metaPath = this.getMetaPath(dataPath);
    try { await unlink(dataPath); } catch (e) { logger.debug({ key, error: e }, "Failed to delete cache data file"); }
    try { await unlink(metaPath); } catch (e) { logger.debug({ key, error: e }, "Failed to delete cache meta file"); }
  }

  async clear(): Promise<void> {
    try {
      const entries = await readdir(this.cacheDir);
      await Promise.all(
        entries
          .filter(e => e.endsWith(".cache") || e.endsWith(".meta"))
          .map(e => unlink(join(this.cacheDir, e)).catch((e) => {
            logger.debug({ file: e, error: e }, "Failed to delete cache file during clear");
          }))
      );
    } catch (e) {
      logger.warn({ cacheDir: this.cacheDir, error: e }, "Failed to clear file cache");
    }
  }

  async clearByPrefix(prefix: string): Promise<void> {
    try {
      const entries = await readdir(this.cacheDir);
      const safePrefix = prefix.replace(/[:/\\*?"<>|]/g, "_");
      await Promise.all(
        entries
          .filter(e => e.endsWith(".cache") && e.startsWith(safePrefix))
          .map(e => {
            const dataPath = join(this.cacheDir, e);
            const metaPath = this.getMetaPath(dataPath);
            return Promise.all([
              unlink(dataPath).catch(() => {}),
              unlink(metaPath).catch(() => {}),
            ]);
          })
      );
    } catch (e) {
      logger.warn({ prefix, error: e }, "Failed to clear file cache by prefix");
    }
  }
}
