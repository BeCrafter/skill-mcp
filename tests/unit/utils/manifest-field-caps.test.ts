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
});
