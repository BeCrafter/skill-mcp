import { readFile, writeFile, unlink, access, readdir, stat, mkdir, rm, rename } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import type { IStorageProvider } from "./provider.interface.js";

export class LocalFileSystemProvider implements IStorageProvider {
  private resolvedBase: string;

  constructor(private basePath: string) {
    this.resolvedBase = resolve(basePath);
    if (!existsSync(basePath)) {
      mkdir(basePath, { recursive: true }).catch(() => {});
    }
  }

  /**
   * T-730 — defense-in-depth: refuse any caller-supplied path that resolves
   * outside `basePath` after `path.resolve` collapses `..` / absolute / drive
   * prefixes. Upstream callers (HTTP handlers, importer) already gate on
   * `validateFilePath` / `safeJoin`, but a future caller bug or non-HTTP
   * surface (CLI, internal service) must not be able to read or overwrite
   * files outside the storage root through this provider.
   */
  private safeResolve(path: string): string {
    const resolved = resolve(this.resolvedBase, path);
    if (resolved !== this.resolvedBase && !resolved.startsWith(this.resolvedBase + sep)) {
      throw new Error(`Path escapes storage base: ${path}`);
    }
    return resolved;
  }

  async get(path: string): Promise<Buffer | null> {
    const fullPath = this.safeResolve(path);
    try {
      return await readFile(fullPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.safeResolve(path));
      return true;
    } catch {
      return false;
    }
  }

  async put(path: string, data: Buffer): Promise<void> {
    const fullPath = this.safeResolve(path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);
  }

  async delete(path: string): Promise<void> {
    const fullPath = this.safeResolve(path);
    try {
      await unlink(fullPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async moveDir(srcPrefix: string, dstPrefix: string): Promise<void> {
    const srcFull = this.safeResolve(srcPrefix);
    const dstFull = this.safeResolve(dstPrefix);
    await mkdir(dirname(dstFull), { recursive: true });
    await rename(srcFull, dstFull);
  }

  async deleteDir(prefix: string): Promise<void> {
    const fullPath = this.safeResolve(prefix);
    try {
      await rm(fullPath, { recursive: true, force: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const fullPath = this.safeResolve(prefix);
    try {
      const entries = await readdir(fullPath);
      return entries.map(e => {
        const p = join(prefix, e);
        return p.replace(/\\/g, "/");
      });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async listRecursive(prefix: string): Promise<string[]> {
    const results: string[] = [];
    await this.walkRecursive(prefix, results);
    return results;
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      const s = await stat(this.safeResolve(path));
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  async size(path: string): Promise<number> {
    const fullPath = this.safeResolve(path);
    const s = await stat(fullPath);
    return s.size;
  }

  private async walkRecursive(currentPrefix: string, results: string[]): Promise<void> {
    const fullPath = this.safeResolve(currentPrefix);
    let entries: Dirent[];
    try {
      entries = await readdir(fullPath, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relativePath = currentPrefix ? `${currentPrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await this.walkRecursive(relativePath, results);
      } else {
        results.push(relativePath);
      }
    }
  }
}
