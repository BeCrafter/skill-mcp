import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalFileSystemProvider } from "../../../src/storage/local-fs.provider.js";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `skill-mcp-storage-test-${process.pid}`);

describe("LocalFileSystemProvider", () => {
  let provider: LocalFileSystemProvider;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    provider = new LocalFileSystemProvider(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should put and get a file", async () => {
    await provider.put("test/file.txt", Buffer.from("hello world"));
    const result = await provider.get("test/file.txt");
    expect(result).not.toBeNull();
    expect(result!.toString()).toBe("hello world");
  });

  it("should return null for non-existent file", async () => {
    const result = await provider.get("nonexistent.txt");
    expect(result).toBeNull();
  });

  it("should delete a file", async () => {
    await provider.put("to-delete.txt", Buffer.from("data"));
    await provider.delete("to-delete.txt");
    expect(await provider.get("to-delete.txt")).toBeNull();
  });

  it("should not throw when deleting non-existent file", async () => {
    await expect(provider.delete("nonexistent.txt")).resolves.not.toThrow();
  });

  it("should recursively delete a directory", async () => {
    await provider.put("dir/a.txt", Buffer.from("a"));
    await provider.put("dir/sub/b.txt", Buffer.from("b"));
    await provider.put("dir/sub/c.txt", Buffer.from("c"));

    await provider.deleteDir("dir");
    expect(await provider.get("dir/a.txt")).toBeNull();
    expect(await provider.get("dir/sub/b.txt")).toBeNull();
  });

  it("should get file size", async () => {
    await provider.put("sized.txt", Buffer.from("hello"));
    const size = await provider.size("sized.txt");
    expect(size).toBe(5);
  });

  it("creates nested parent directories when writing deeply-nested paths (T-002)", async () => {
    await provider.put("a/b/c/d.txt", Buffer.from("nested"));
    const result = await provider.get("a/b/c/d.txt");
    expect(result?.toString()).toBe("nested");
    // Sibling read paths should resolve via the actual parent (dirname),
    // not via the file-as-directory shape produced by the previous
    // join(fullPath, "..") pattern.
    await provider.put("a/b/c/e.txt", Buffer.from("sibling"));
    expect((await provider.get("a/b/c/e.txt"))?.toString()).toBe("sibling");
  });

  describe("T-730 — defense-in-depth path bounds", () => {
    it("rejects get() with `..` traversal that escapes basePath", async () => {
      await expect(provider.get("../etc/passwd")).rejects.toThrow(/escapes storage base/);
    });

    it("rejects put() with `..` traversal that escapes basePath", async () => {
      await expect(provider.put("../evil.txt", Buffer.from("x"))).rejects.toThrow(/escapes storage base/);
    });

    it("rejects delete() with `..` traversal that escapes basePath", async () => {
      await expect(provider.delete("../../target")).rejects.toThrow(/escapes storage base/);
    });

    it("rejects deleteDir() with absolute path that escapes basePath", async () => {
      await expect(provider.deleteDir("/tmp/elsewhere")).rejects.toThrow(/escapes storage base/);
    });

    it("rejects moveDir() with `..` traversal that escapes basePath", async () => {
      await expect(provider.moveDir("legit/", "../escape/")).rejects.toThrow(/escapes storage base/);
    });

    it("permits internal `..` segments that resolve back inside basePath", async () => {
      await provider.put("inner/file.txt", Buffer.from("ok"));
      // `inner/../inner/file.txt` resolves to inner/file.txt — still inside.
      const got = await provider.get("inner/../inner/file.txt");
      expect(got?.toString()).toBe("ok");
    });
  });
});
