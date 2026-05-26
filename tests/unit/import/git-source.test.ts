import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitSourceResolver } from "@/import/git-source.js";
import { BadRequestError } from "@/utils/errors.js";

const rawSpy = vi.fn(async () => "");
vi.mock("simple-git", () => ({
  simpleGit: () => ({
    raw: rawSpy,
    clone: vi.fn(),
  }),
}));

describe("GitSourceResolver argv hardening (T-603)", () => {
  beforeEach(() => {
    rawSpy.mockClear();
    rawSpy.mockResolvedValue("");
  });

  it("rejects repoUrl that starts with a flag", async () => {
    const r = new GitSourceResolver();
    await expect(r.resolve("--upload-pack=touch /tmp/pwn")).rejects.toBeInstanceOf(BadRequestError);
    expect(rawSpy).not.toHaveBeenCalled();
  });

  it("rejects repoUrl with non-allowed scheme", async () => {
    const r = new GitSourceResolver();
    await expect(r.resolve("file:///etc/passwd")).rejects.toBeInstanceOf(BadRequestError);
    await expect(r.resolve("javascript:alert(1)")).rejects.toBeInstanceOf(BadRequestError);
    expect(rawSpy).not.toHaveBeenCalled();
  });

  it("rejects branch shaped like a flag", async () => {
    const r = new GitSourceResolver();
    await expect(
      r.resolve("https://example.com/repo.git", { branch: "--upload-pack=x" }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(rawSpy).not.toHaveBeenCalled();
  });

  it("calls git raw with `--` separator before positional args", async () => {
    // Make raw "succeed" but throw on the post-clone manifest read so we
    // don't need a real checkout — we only care about the argv shape.
    rawSpy.mockImplementationOnce(async () => "");
    const r = new GitSourceResolver();
    await expect(
      r.resolve("https://example.com/repo.git", { branch: "main" }),
    ).rejects.toThrow(); // SKILL.md not found in tmpdir, expected
    expect(rawSpy).toHaveBeenCalledTimes(1);
    const argv = rawSpy.mock.calls[0][0] as string[];
    expect(argv[0]).toBe("clone");
    const sepIdx = argv.indexOf("--");
    expect(sepIdx).toBeGreaterThan(0);
    // repoUrl & tmpDir are AFTER the separator
    expect(argv[sepIdx + 1]).toBe("https://example.com/repo.git");
    expect(argv[sepIdx + 2]).toMatch(/skill-import-/);
    // branch flag is BEFORE the separator
    expect(argv.indexOf("--branch")).toBeLessThan(sepIdx);
    expect(argv.indexOf("main")).toBeLessThan(sepIdx);
  });

  it("T-719: rejects subDir that escapes the cloned tree", async () => {
    rawSpy.mockResolvedValue("");
    const r = new GitSourceResolver();
    await expect(
      r.resolve("https://example.com/repo.git", { subDir: "../../../etc" }),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      r.resolve("https://example.com/repo.git", { subDir: "/etc" }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
