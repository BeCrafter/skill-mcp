import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AliyunOssProvider } from "../../../src/storage/aliyun-oss.provider.js";

// Mock ali-oss module
const mockClient = {
  get: vi.fn(),
  head: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  deleteMulti: vi.fn(),
  list: vi.fn(),
};

vi.mock("ali-oss", () => ({
  default: vi.fn(() => mockClient),
}));

import OSS from "ali-oss";

// Type for the mocked OSS client
type MockOssClient = {
  get: ReturnType<typeof vi.fn>;
  head: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  deleteMulti: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
};

function getMockClient(): MockOssClient {
  return mockClient as MockOssClient;
}

describe("AliyunOssProvider", () => {
  let provider: AliyunOssProvider;
  let mockClient: MockOssClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = getMockClient();
    provider = new AliyunOssProvider({
      bucket: "test-bucket",
      region: "oss-cn-hangzhou",
      accessKeyId: "test-key",
      accessKeySecret: "test-secret",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should initialize OSS client with config", () => {
      expect(OSS).toHaveBeenCalledWith({
        bucket: "test-bucket",
        region: "oss-cn-hangzhou",
        accessKeyId: "test-key",
        accessKeySecret: "test-secret",
      });
    });

    it("should handle optional credentials", () => {
      new AliyunOssProvider({
        bucket: "test-bucket",
        region: "oss-cn-hangzhou",
      });

      expect(OSS).toHaveBeenCalledWith({
        bucket: "test-bucket",
        region: "oss-cn-hangzhou",
        accessKeyId: "",
        accessKeySecret: "",
      });
    });
  });

  describe("get", () => {
    it("should return buffer for existing file", async () => {
      mockClient.get.mockResolvedValue({
        content: Buffer.from("test content"),
      });

      const result = await provider.get("test/file.txt");

      expect(result).not.toBeNull();
      expect(result!.toString()).toBe("test content");
      expect(mockClient.get).toHaveBeenCalledWith("test/file.txt");
    });

    it("should return null for NoSuchKey error", async () => {
      mockClient.get.mockRejectedValue({ code: "NoSuchKey" });

      const result = await provider.get("nonexistent.txt");

      expect(result).toBeNull();
    });

    it("should return null for NoSuchKeyError", async () => {
      mockClient.get.mockRejectedValue({ name: "NoSuchKeyError" });

      const result = await provider.get("nonexistent.txt");

      expect(result).toBeNull();
    });

    it("should throw for other errors", async () => {
      const error = new Error("Network error");
      mockClient.get.mockRejectedValue(error);

      await expect(provider.get("file.txt")).rejects.toThrow("Network error");
    });
  });

  describe("exists", () => {
    it("should return true when file exists", async () => {
      mockClient.head.mockResolvedValue({});

      const result = await provider.exists("exists.txt");

      expect(result).toBe(true);
      expect(mockClient.head).toHaveBeenCalledWith("exists.txt");
    });

    it("should return false for any error", async () => {
      mockClient.head.mockRejectedValue({ code: "NoSuchKey" });

      const result = await provider.exists("nonexistent.txt");

      expect(result).toBe(false);
    });
  });

  describe("put", () => {
    it("should put buffer to OSS", async () => {
      mockClient.put.mockResolvedValue({});

      await provider.put("test/file.txt", Buffer.from("content"));

      expect(mockClient.put).toHaveBeenCalledWith(
        "test/file.txt",
        Buffer.from("content")
      );
    });
  });

  describe("delete", () => {
    it("should delete file from OSS", async () => {
      mockClient.delete.mockResolvedValue({});

      await provider.delete("to-delete.txt");

      expect(mockClient.delete).toHaveBeenCalledWith("to-delete.txt");
    });

    it("should not throw when deleting non-existent file (NoSuchKey)", async () => {
      mockClient.delete.mockRejectedValue({ code: "NoSuchKey" });

      await expect(provider.delete("nonexistent.txt")).resolves.not.toThrow();
    });

    it("should not throw when deleting non-existent file (NoSuchKeyError)", async () => {
      mockClient.delete.mockRejectedValue({ name: "NoSuchKeyError" });

      await expect(provider.delete("nonexistent.txt")).resolves.not.toThrow();
    });

    it("should throw for other errors", async () => {
      mockClient.delete.mockRejectedValue(new Error("Permission denied"));

      await expect(provider.delete("file.txt")).rejects.toThrow(
        "Permission denied"
      );
    });
  });

  describe("deleteDir", () => {
    it("should delete all files under prefix", async () => {
      // First page
      mockClient.list.mockResolvedValueOnce({
        objects: [
          { name: "dir/file1.txt" },
          { name: "dir/file2.txt" },
        ],
        nextMarker: undefined,
      });
      mockClient.deleteMulti.mockResolvedValue({});

      await provider.deleteDir("dir");

      expect(mockClient.list).toHaveBeenCalledWith(
        { prefix: "dir/", marker: undefined, "max-keys": 1000 },
        {}
      );
      expect(mockClient.deleteMulti).toHaveBeenCalledWith([
        "dir/file1.txt",
        "dir/file2.txt",
      ]);
    });

    it("should handle pagination for large directories", async () => {
      // First page
      mockClient.list.mockResolvedValueOnce({
        objects: Array.from({ length: 1000 }, (_, i) => ({
          name: `dir/file${i}.txt`,
        })),
        nextMarker: "marker-1",
      });

      // Second page
      mockClient.list.mockResolvedValueOnce({
        objects: [
          { name: "dir/file1000.txt" },
          { name: "dir/file1001.txt" },
        ],
        nextMarker: undefined,
      });

      mockClient.deleteMulti.mockResolvedValue({});

      await provider.deleteDir("dir");

      expect(mockClient.list).toHaveBeenCalledTimes(2);
      expect(mockClient.deleteMulti).toHaveBeenCalledTimes(2);
    });

    it("should normalize prefix without trailing slash", async () => {
      mockClient.list.mockResolvedValue({
        objects: [{ name: "dir/file.txt" }],
        nextMarker: undefined,
      });
      mockClient.deleteMulti.mockResolvedValue({});

      await provider.deleteDir("dir");

      expect(mockClient.list).toHaveBeenCalledWith(
        { prefix: "dir/", marker: undefined, "max-keys": 1000 },
        {}
      );
    });

    it("should skip delete when directory is empty", async () => {
      mockClient.list.mockResolvedValue({
        objects: [],
        nextMarker: undefined,
      });

      await provider.deleteDir("empty-dir");

      expect(mockClient.deleteMulti).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("should list immediate children under prefix", async () => {
      mockClient.list.mockResolvedValue({
        objects: [
          { name: "skills/file1.txt" },
          { name: "skills/file2.txt" },
          // Note: OSS with delimiter "/" would filter out subdir objects
          // This is a simplified test assuming OSS returns correct results
        ],
        nextMarker: undefined,
      });

      const result = await provider.list("skills");

      expect(result).toHaveLength(2);
      expect(result).toContain("skills/file1.txt");
      expect(result).toContain("skills/file2.txt");
    });

    it("should return empty array for non-existent prefix", async () => {
      mockClient.list.mockResolvedValue({
        objects: undefined,
      });

      const result = await provider.list("nonexistent");

      expect(result).toEqual([]);
    });

    it("should use delimiter to get immediate children only", async () => {
      mockClient.list.mockResolvedValue({
        objects: [],
      });

      await provider.list("skills");

      expect(mockClient.list).toHaveBeenCalledWith(
        { prefix: "skills", delimiter: "/", "max-keys": 1000 },
        {}
      );
    });
  });

  describe("listRecursive", () => {
    it("should list all files recursively", async () => {
      mockClient.list.mockResolvedValue({
        objects: [
          { name: "dir/file1.txt" },
          { name: "dir/subdir/file2.txt" },
          { name: "dir/subdir/deep/file3.txt" },
        ],
        nextMarker: undefined,
      });

      const result = await provider.listRecursive("dir");

      expect(result).toHaveLength(3);
      // Returns full paths (consistent with LocalFileSystemProvider)
      expect(result).toContain("dir/file1.txt");
      expect(result).toContain("dir/subdir/file2.txt");
      expect(result).toContain("dir/subdir/deep/file3.txt");
    });

    it("should handle pagination", async () => {
      // First page
      mockClient.list.mockResolvedValueOnce({
        objects: Array.from({ length: 1000 }, (_, i) => ({
          name: `dir/file${i}.txt`,
        })),
        nextMarker: "marker-1",
      });

      // Second page
      mockClient.list.mockResolvedValueOnce({
        objects: [
          { name: "dir/file1000.txt" },
          { name: "dir/file1001.txt" },
        ],
        nextMarker: undefined,
      });

      const result = await provider.listRecursive("dir");

      expect(result).toHaveLength(1002);
      expect(mockClient.list).toHaveBeenCalledTimes(2);
    });

    it("should exclude prefix itself from results", async () => {
      mockClient.list.mockResolvedValue({
        objects: [
          { name: "dir/" }, // Prefix itself
          { name: "dir/file.txt" },
        ],
        nextMarker: undefined,
      });

      const result = await provider.listRecursive("dir");

      expect(result).toHaveLength(1);
      expect(result[0]).toBe("dir/file.txt");
    });

    it("should normalize prefix without trailing slash", async () => {
      mockClient.list.mockResolvedValue({
        objects: [{ name: "dir/file.txt" }],
        nextMarker: undefined,
      });

      await provider.listRecursive("dir");

      expect(mockClient.list).toHaveBeenCalledWith(
        { prefix: "dir/", marker: undefined, "max-keys": 1000 },
        {}
      );
    });
  });

  describe("isDirectory", () => {
    it("should return true when prefix has objects", async () => {
      mockClient.list.mockResolvedValue({
        objects: [{ name: "dir/file.txt" }],
      });

      const result = await provider.isDirectory("dir");

      expect(result).toBe(true);
      expect(mockClient.list).toHaveBeenCalledWith(
        { prefix: "dir/", "max-keys": 1 },
        {}
      );
    });

    it("should return false when prefix has no objects", async () => {
      mockClient.list.mockResolvedValue({
        objects: [],
      });

      const result = await provider.isDirectory("empty");

      expect(result).toBe(false);
    });

    it("should return false when objects is undefined", async () => {
      mockClient.list.mockResolvedValue({
        objects: undefined,
      });

      const result = await provider.isDirectory("empty");

      expect(result).toBe(false);
    });
  });

  describe("size", () => {
    it("should return file size from headers", async () => {
      mockClient.head.mockResolvedValue({
        res: { headers: { "content-length": "12345" } },
      });

      const result = await provider.size("file.txt");

      expect(result).toBe(12345);
      expect(mockClient.head).toHaveBeenCalledWith("file.txt");
    });

    it("should return 0 when content-length header is missing", async () => {
      mockClient.head.mockResolvedValue({
        res: { headers: {} },
      });

      const result = await provider.size("file.txt");

      expect(result).toBe(0);
    });

    it("should parse content-length as integer", async () => {
      mockClient.head.mockResolvedValue({
        res: { headers: { "content-length": "999" } },
      });

      const result = await provider.size("file.txt");

      expect(result).toBe(999);
    });
  });
});