import { describe, it, expect } from "vitest";
import { slugify, computeContentHash } from "../../../src/utils/manifest.js";

describe("slugify", () => {
  it("should convert to kebab-case", () => {
    expect(slugify("Prompt Writer")).toBe("prompt-writer");
    expect(slugify("Code Review Skill")).toBe("code-review-skill");
    expect(slugify("hello-world")).toBe("hello-world");
  });

  it("should handle special characters", () => {
    expect(slugify("My Skill @2024!")).toBe("my-skill-2024");
  });
});

describe("computeContentHash", () => {
  it("should produce consistent hash for same files", () => {
    const files = [
      { path: "SKILL.md", buffer: Buffer.from("content1") },
      { path: "refs/doc.md", buffer: Buffer.from("content2") },
    ];
    const hash1 = computeContentHash(files);
    const hash2 = computeContentHash(files);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^sha256:[a-f0-9]+$/);
  });

  it("should produce different hash for different content", () => {
    const files1 = [{ path: "SKILL.md", buffer: Buffer.from("content1") }];
    const files2 = [{ path: "SKILL.md", buffer: Buffer.from("content2") }];
    expect(computeContentHash(files1)).not.toBe(computeContentHash(files2));
  });
});
