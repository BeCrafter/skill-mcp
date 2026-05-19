import OSS from "ali-oss";
import type { IStorageProvider } from "./provider.interface.js";

interface AliyunOssConfig {
  bucket: string;
  region: string;
  accessKeyId?: string;
  accessKeySecret?: string;
}

export class AliyunOssProvider implements IStorageProvider {
  private client: OSS;

  constructor(config: AliyunOssConfig) {
    this.client = new OSS({
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId ?? "",
      accessKeySecret: config.accessKeySecret ?? "",
    });
  }

  async get(path: string): Promise<Buffer | null> {
    try {
      const result = await this.client.get(path);
      return Buffer.from(result.content);
    } catch (e: any) {
      if (e.code === "NoSuchKey" || e.name === "NoSuchKeyError") return null;
      throw e;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.client.head(path);
      return true;
    } catch {
      return false;
    }
  }

  async put(path: string, data: Buffer): Promise<void> {
    await this.client.put(path, data);
  }

  async delete(path: string): Promise<void> {
    try {
      await this.client.delete(path);
    } catch (e: any) {
      if (e.code !== "NoSuchKey" && e.name !== "NoSuchKeyError") throw e;
    }
  }

  async deleteDir(prefix: string): Promise<void> {
    const normalizedPrefix = prefix.endsWith("/") ? prefix : prefix + "/";
    let marker: string | undefined;
    do {
      const result = await this.client.list({ prefix: normalizedPrefix, marker, "max-keys": 1000 }, {});
      if (result.objects && result.objects.length > 0) {
        const keys = result.objects.map(o => o.name);
        if (keys.length > 0) {
          await this.client.deleteMulti(keys);
        }
      }
      marker = result.nextMarker;
    } while (marker);
  }

  async list(prefix: string): Promise<string[]> {
    const result = await this.client.list({ prefix, delimiter: "/", "max-keys": 1000 }, {});
    const items: string[] = [];
    if (result.objects) {
      // Return full paths with prefix (consistent with LocalFileSystemProvider)
      items.push(...result.objects.map(o => o.name));
    }
    return items;
  }

  async listRecursive(prefix: string): Promise<string[]> {
    const normalizedPrefix = prefix.endsWith("/") ? prefix : prefix + "/";
    const items: string[] = [];
    let marker: string | undefined;
    do {
      const result = await this.client.list({ prefix: normalizedPrefix, marker, "max-keys": 1000 }, {});
      if (result.objects) {
        for (const obj of result.objects) {
          if (obj.name !== normalizedPrefix) {
            // Return full paths with prefix (consistent with LocalFileSystemProvider)
            items.push(obj.name);
          }
        }
      }
      marker = result.nextMarker;
    } while (marker);
    return items;
  }

  async isDirectory(path: string): Promise<boolean> {
    const result = await this.client.list({ prefix: path + "/", "max-keys": 1 }, {});
    return (result.objects?.length ?? 0) > 0;
  }

  async size(path: string): Promise<number> {
    const result = await this.client.head(path);
    const headers = result.res.headers as Record<string, string>;
    return parseInt(headers["content-length"] ?? "0", 10);
  }
}