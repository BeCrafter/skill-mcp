import OSS from "ali-oss";
import type { IStorageProvider } from "./provider.interface.js";
import { withSpan } from "../telemetry/spans.js";

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
    return withSpan("storage.read", { attributes: { "storage.backend": "aliyun-oss", "storage.path": path } }, async () => {
      try {
        const result = await this.client.get(path);
        return Buffer.from(result.content);
      } catch (e: unknown) {
        const error = e as { code?: string; name?: string };
        if (error.code === "NoSuchKey" || error.name === "NoSuchKeyError") return null;
        throw e;
      }
    });
  }

  async put(path: string, data: Buffer): Promise<void> {
    await this.client.put(path, data);
  }

  async delete(path: string): Promise<void> {
    try {
      await this.client.delete(path);
    } catch (e: unknown) {
      const error = e as { code?: string; name?: string };
      if (error.code !== "NoSuchKey" && error.name !== "NoSuchKeyError") throw e;
    }
  }

  async moveDir(srcPrefix: string, dstPrefix: string): Promise<void> {
    const normSrc = srcPrefix.endsWith("/") ? srcPrefix : srcPrefix + "/";
    const normDst = dstPrefix.endsWith("/") ? dstPrefix : dstPrefix + "/";
    let marker: string | undefined;
    do {
      const result = await this.client.list({ prefix: normSrc, marker, "max-keys": 1000 }, {});
      if (result.objects && result.objects.length > 0) {
        for (const obj of result.objects) {
          const relative = obj.name.slice(normSrc.length);
          if (!relative) continue;
          const dstKey = normDst + relative;
          await this.client.copy(dstKey, obj.name);
          await this.client.delete(obj.name);
        }
      }
      marker = result.nextMarker;
    } while (marker);
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

  async size(path: string): Promise<number> {
    const result = await this.client.head(path);
    const headers = result.res.headers as Record<string, string>;
    return parseInt(headers["content-length"] ?? "0", 10);
  }
}