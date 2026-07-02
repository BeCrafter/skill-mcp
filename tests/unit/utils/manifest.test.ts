import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { slugify, computeContentHash, parseSkillMeta } from "../../../src/utils/manifest.js";

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

// P1-11 — parser must surface retrieval-signal fields from SKILL.md frontmatter
// so the importer / search layer can persist and rank against them.
describe("parseSkillMeta retrieval-signal fields (P1-11)", () => {
  let dirPath: string;

  beforeEach(() => {
    dirPath = mkdtempSync(join(tmpdir(), "manifest-p111-"));
  });

  afterEach(() => {
    rmSync(dirPath, { recursive: true, force: true });
  });

  function writeSkill(frontmatter: string): void {
    writeFileSync(join(dirPath, "SKILL.md"), `---\n${frontmatter}\n---\n# body`);
  }

  it("parses triggers / when_to_use / embedding_text when present", () => {
    writeSkill([
      `name: ripgrep-helper`,
      `triggers:`,
      `  - "search a directory"`,
      `  - "find regex"`,
      `when_to_use: "the user is looking for files matching a pattern"`,
      `embedding_text: "ripgrep wrapper; recursive directory pattern search"`,
    ].join("\n"));
    const meta = parseSkillMeta(dirPath);
    expect(meta.triggers).toEqual(["search a directory", "find regex"]);
    expect(meta.whenToUse).toBe("the user is looking for files matching a pattern");
    expect(meta.embeddingText).toBe("ripgrep wrapper; recursive directory pattern search");
  });

  it("returns undefined for absent retrieval fields (legacy compat)", () => {
    writeSkill(`name: legacy-skill`);
    const meta = parseSkillMeta(dirPath);
    expect(meta.triggers).toBeUndefined();
    expect(meta.whenToUse).toBeUndefined();
    expect(meta.embeddingText).toBeUndefined();
  });

  it("preserves existing fields alongside new retrieval fields", () => {
    writeSkill([
      `name: combo`,
      `version: 0.1.0`,
      `description: "combo skill"`,
      `tags: [search, cli]`,
      `triggers: ["combo"]`,
    ].join("\n"));
    const meta = parseSkillMeta(dirPath);
    expect(meta.name).toBe("combo");
    expect(meta.version).toBe("0.1.0");
    expect(meta.description).toBe("combo skill");
    expect(meta.tags).toEqual(["search", "cli"]);
    expect(meta.triggers).toEqual(["combo"]);
    expect(meta.whenToUse).toBeUndefined();
    expect(meta.embeddingText).toBeUndefined();
  });
});

// P1-12 stage 1 — frontmatter parser surfaces eval_cases (snake_case) and
// normalizes both snake_case and camelCase keys inside each case object.
describe("parseSkillMeta eval_cases (P1-12 stage 1)", () => {
  let dirPath: string;

  beforeEach(() => {
    dirPath = mkdtempSync(join(tmpdir(), "manifest-p112-"));
  });

  afterEach(() => {
    rmSync(dirPath, { recursive: true, force: true });
  });

  function writeSkill(frontmatter: string): void {
    writeFileSync(join(dirPath, "SKILL.md"), `---\n${frontmatter}\n---\n# body`);
  }

  it("parses eval_cases with snake_case keys and normalizes to camelCase", () => {
    writeSkill([
      `name: ripgrep-helper`,
      `eval_cases:`,
      `  - name: "basic"`,
      `    input: "find foo"`,
      `    expected_output_contains: ["matched"]`,
      `    expected_output_not_contains: ["error"]`,
    ].join("\n"));
    const meta = parseSkillMeta(dirPath);
    expect(meta.evalCases).toHaveLength(1);
    expect(meta.evalCases![0]).toEqual({
      name: "basic",
      input: "find foo",
      expectedOutputContains: ["matched"],
      expectedOutputNotContains: ["error"],
    });
  });

  it("returns undefined when eval_cases is absent", () => {
    writeSkill(`name: legacy-skill`);
    const meta = parseSkillMeta(dirPath);
    expect(meta.evalCases).toBeUndefined();
  });

  it("parses minimal eval case with only name and input", () => {
    writeSkill([
      `name: combo`,
      `eval_cases:`,
      `  - name: "via-camel"`,
      `    input: "x"`,
    ].join("\n"));
    const meta = parseSkillMeta(dirPath);
    expect(meta.evalCases).toHaveLength(1);
    expect(meta.evalCases![0].name).toBe("via-camel");
    expect(meta.evalCases![0].input).toBe("x");
  });
});
