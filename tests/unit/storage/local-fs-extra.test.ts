import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalFileSystemProvider } from "@/storage/local-fs.provider.js";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `skill-mcp-storage-extra-${process.pid}`);

describe("LocalFileSystemProvider — additional surface", () => {
  let p: LocalFileSystemProvider;

  beforeEach(() => {
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    p = new LocalFileSystemProvider(ROOT);
  });
  afterEach(() => {
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  });

  it("moveDir relocates a populated directory and clears the source", async () => {
    await p.put("a/x.txt", Buffer.from("hi"));
    await p.put("a/sub/y.txt", Buffer.from("there"));
    await p.moveDir("a", "b");
    expect(await p.exists("a/x.txt")).toBe(false);
    expect((await p.get("b/x.txt"))?.toString()).toBe("hi");
    expect((await p.get("b/sub/y.txt"))?.toString()).toBe("there");
  });

  it("isDirectory distinguishes directories from files and missing paths", async () => {
    await p.put("dir/keep.txt", Buffer.from("k"));
    expect(await p.isDirectory("dir")).toBe(true);
    expect(await p.isDirectory("dir/keep.txt")).toBe(false);
    expect(await p.isDirectory("totally-missing")).toBe(false);
  });

  it("listRecursive walks subtrees and skips dotfiles", async () => {
    await p.put("root/a.md", Buffer.from("a"));
    await p.put("root/sub/b.md", Buffer.from("b"));
    await p.put("root/.hidden", Buffer.from("h"));
    const files = await p.listRecursive("root");
    expect(files.sort()).toEqual(["root/a.md", "root/sub/b.md"]);
  });

  it("listRecursive returns [] for missing prefixes", async () => {
    expect(await p.listRecursive("nope")).toEqual([]);
  });

  it("deleteDir on a missing prefix is a no-op (ENOENT swallowed)", async () => {
    await expect(p.deleteDir("never-existed")).resolves.not.toThrow();
  });

  it("size throws for missing files", async () => {
    await expect(p.size("does/not/exist.txt")).rejects.toBeTruthy();
  });

  it("safeResolve rejects path-bound escapes on listRecursive too", async () => {
    await expect(p.listRecursive("../escape")).rejects.toThrow(/escapes storage base/);
  });
});
