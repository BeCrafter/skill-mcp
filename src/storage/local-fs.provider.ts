import { readFile, writeFile, unlink, access, readdir, stat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import type { IStorageProvider } from "./provider.interface.js";

export class LocalFileSystemProvider implements IStorageProvider {
  constructor(private basePath: string) {
    if (!existsSync(basePath)) {
      mkdir(basePath, { recursive: true }).catch(() => {});
    }
  }

  async get(path: string): Promise<Buffer | null> {
    const fullPath = join(this.basePath, path);
    try {
      return await readFile(fullPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(join(this.basePath, path));
      return true;
    } catch {
      return false;
    }
  }

  async put(path: string, data: Buffer): Promise<void> {
    const fullPath = join(this.basePath, path);
    const dir = join(fullPath, "..");
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, data);
  }

  async delete(path: string): Promise<void> {
    const fullPath = join(this.basePath, path);
    try {
      await unlink(fullPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async deleteDir(prefix: string): Promise<void> {
    const fullPath = join(this.basePath, prefix);
    try {
      await rm(fullPath, { recursive: true, force: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const fullPath = join(this.basePath, prefix);
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
      const s = await stat(join(this.basePath, path));
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  async size(path: string): Promise<number> {
    const fullPath = join(this.basePath, path);
    const s = await stat(fullPath);
    return s.size;
  }

  private async walkRecursive(currentPrefix: string, results: string[]): Promise<void> {
    const fullPath = join(this.basePath, currentPrefix);
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
