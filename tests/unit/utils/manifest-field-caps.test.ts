import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateSkillMeta } from "../../../src/utils/manifest.js";

/**
 * T-705 — frontmatter field caps. A malicious package can ride the 50 MiB
 * total-bytes cap and stuff multi-megabyte strings into single fields, which
 * then persist to SQLite TEXT columns and balloon every listing response.
 */
describe("validateSkillMeta field caps (T-705)", () => {
  let dirPath: string;

  beforeEach(() => {
    dirPath = mkdtempSync(join(tmpdir(), "manifest-caps-"));
    writeFileSync(join(dirPath, "SKILL.md"), "# Skill");
  });

  afterEach(() => {
    rmSync(dirPath, { recursive: true, force: true });
  });

  it("accepts metadata within all caps", () => {
    expect(() =>
      validateSkillMeta(
        {
          name: "ok",
          version: "1.0.0",
          description: "small",
          category: "general",
          tags: ["a", "b"],
        },
        dirPath,
      ),
    ).not.toThrow();
  });

  it("rejects oversized name", () => {
    expect(() =>
      validateSkillMeta({ name: "x".repeat(201) }, dirPath),
    ).toThrow(/name exceeds max length/);
  });

  it("rejects oversized version", () => {
    expect(() =>
      validateSkillMeta({ name: "ok", version: "v".repeat(65) }, dirPath),
    ).toThrow(/version exceeds max length/);
  });

  it("rejects oversized description", () => {
    expect(() =>
      validateSkillMeta(
        { name: "ok", description: "d".repeat(4097) },
        dirPath,
      ),
    ).toThrow(/description exceeds max length/);
  });

  it("rejects oversized category", () => {
    expect(() =>
      validateSkillMeta(
        { name: "ok", category: "c".repeat(129) },
        dirPath,
      ),
    ).toThrow(/category exceeds max length/);
  });

  it("rejects too many tags", () => {
    const tags = Array.from({ length: 65 }, (_, i) => `tag-${i}`);
    expect(() =>
      validateSkillMeta({ name: "ok", tags }, dirPath),
    ).toThrow(/tags exceed max count/);
  });

  it("rejects oversized tag entry", () => {
    expect(() =>
      validateSkillMeta(
        { name: "ok", tags: ["fine", "x".repeat(65)] },
        dirPath,
      ),
    ).toThrow(/tag exceeds max length/);
  });

  // P1-11 — retrieval-signal field caps.
  it("accepts triggers / when_to_use / embedding_text within caps", () => {
    expect(() =>
      validateSkillMeta(
        {
          name: "ok",
          triggers: ["search files", "find regex"],
          whenToUse: "use this when the user wants to search a directory tree",
          embeddingText: "ripgrep-style file search; fast pattern matching",
        },
        dirPath,
      ),
    ).not.toThrow();
  });

  it("rejects triggers that are not an array", () => {
    expect(() =>
      validateSkillMeta(
        { name: "ok", triggers: "not-an-array" as unknown as string[] },
        dirPath,
      ),
    ).toThrow(/triggers must be an array/);
  });

  it("rejects too many triggers (>32)", () => {
    const triggers = Array.from({ length: 33 }, (_, i) => `t-${i}`);
    expect(() =>
      validateSkillMeta({ name: "ok", triggers }, dirPath),
    ).toThrow(/triggers exceed max count/);
  });

  it("rejects oversized trigger entry (>128 chars)", () => {
    expect(() =>
      validateSkillMeta(
        { name: "ok", triggers: ["fine", "x".repeat(129)] },
        dirPath,
      ),
    ).toThrow(/trigger exceeds max length/);
  });

  it("rejects non-string trigger entry", () => {
    expect(() =>
      validateSkillMeta(
        { name: "ok", triggers: ["fine", 42 as unknown as string] },
        dirPath,
      ),
    ).toThrow(/trigger must be a string/);
  });

  it("rejects when_to_use that is not a string", () => {
    expect(() =>
      validateSkillMeta(
        { name: "ok", whenToUse: 42 as unknown as string },
        dirPath,
      ),
    ).toThrow(/when_to_use must be a string/);
  });

  it("rejects oversized when_to_use (>2048 chars)", () => {
    expect(() =>
      validateSkillMeta(
        { name: "ok", whenToUse: "w".repeat(2049) },
        dirPath,
      ),
    ).toThrow(/when_to_use exceeds max length/);
  });

  it("rejects embedding_text that is not a string", () => {
    expect(() =>
      validateSkillMeta(
        { name: "ok", embeddingText: {} as unknown as string },
        dirPath,
      ),
    ).toThrow(/embedding_text must be a string/);
  });

  it("rejects oversized embedding_text (>8192 chars)", () => {
    expect(() =>
      validateSkillMeta(
        { name: "ok", embeddingText: "e".repeat(8193) },
        dirPath,
      ),
    ).toThrow(/embedding_text exceeds max length/);
  });
});
