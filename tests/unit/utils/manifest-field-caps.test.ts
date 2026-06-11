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

  // P1-12 stage 1 — eval_cases field caps. Mirrors the retrieval-signal
  // pattern: validation rejects malformed shapes + cap violations + cases
  // with no expectations.
  describe("eval_cases (P1-12 stage 1)", () => {
    it("accepts a well-formed minimal case (expected_tools only)", () => {
      expect(() =>
        validateSkillMeta(
          {
            name: "ok",
            evalCases: [{ name: "case-a", input: "do thing", expectedTools: ["search"] }],
          },
          dirPath,
        ),
      ).not.toThrow();
    });

    it("accepts a case with all three expectation lists", () => {
      expect(() =>
        validateSkillMeta(
          {
            name: "ok",
            evalCases: [
              {
                name: "full",
                input: "compose the answer",
                expectedTools: ["fetch", "format"],
                expectedOutputContains: ["Hello"],
                expectedOutputNotContains: ["error"],
              },
            ],
          },
          dirPath,
        ),
      ).not.toThrow();
    });

    it("rejects eval_cases that is not an array", () => {
      expect(() =>
        validateSkillMeta(
          { name: "ok", evalCases: "nope" as unknown as never },
          dirPath,
        ),
      ).toThrow(/eval_cases must be an array/);
    });

    it("rejects more than 32 cases", () => {
      const cases = Array.from({ length: 33 }, (_, i) => ({
        name: `c-${i}`,
        input: "x",
        expectedTools: ["a"],
      }));
      expect(() =>
        validateSkillMeta({ name: "ok", evalCases: cases }, dirPath),
      ).toThrow(/eval_cases exceed max count/);
    });

    it("rejects a case with empty name", () => {
      expect(() =>
        validateSkillMeta(
          { name: "ok", evalCases: [{ name: "", input: "x", expectedTools: ["a"] }] },
          dirPath,
        ),
      ).toThrow(/name is required/);
    });

    it("rejects oversized case name (>128 chars)", () => {
      expect(() =>
        validateSkillMeta(
          {
            name: "ok",
            evalCases: [{ name: "n".repeat(129), input: "x", expectedTools: ["a"] }],
          },
          dirPath,
        ),
      ).toThrow(/name exceeds max length/);
    });

    it("rejects duplicate case names within one skill", () => {
      expect(() =>
        validateSkillMeta(
          {
            name: "ok",
            evalCases: [
              { name: "dup", input: "x", expectedTools: ["a"] },
              { name: "dup", input: "y", expectedTools: ["b"] },
            ],
          },
          dirPath,
        ),
      ).toThrow(/duplicated/);
    });

    it("rejects empty input", () => {
      expect(() =>
        validateSkillMeta(
          { name: "ok", evalCases: [{ name: "c", input: "", expectedTools: ["a"] }] },
          dirPath,
        ),
      ).toThrow(/input is required/);
    });

    it("rejects oversized input (>4096 chars)", () => {
      expect(() =>
        validateSkillMeta(
          {
            name: "ok",
            evalCases: [{ name: "c", input: "x".repeat(4097), expectedTools: ["a"] }],
          },
          dirPath,
        ),
      ).toThrow(/input exceeds max length/);
    });

    it("rejects a case with no expectations at all", () => {
      expect(() =>
        validateSkillMeta(
          { name: "ok", evalCases: [{ name: "c", input: "x" }] },
          dirPath,
        ),
      ).toThrow(/at least one of expected_tools/);
    });

    it("rejects too many expected_tools (>16)", () => {
      const tools = Array.from({ length: 17 }, (_, i) => `tool-${i}`);
      expect(() =>
        validateSkillMeta(
          { name: "ok", evalCases: [{ name: "c", input: "x", expectedTools: tools }] },
          dirPath,
        ),
      ).toThrow(/expected_tools exceed max count/);
    });

    it("rejects oversized expected_output_contains entry (>1024 chars)", () => {
      expect(() =>
        validateSkillMeta(
          {
            name: "ok",
            evalCases: [
              {
                name: "c",
                input: "x",
                expectedOutputContains: ["x".repeat(1025)],
              },
            ],
          },
          dirPath,
        ),
      ).toThrow(/expected_output_contains entry exceeds max length/);
    });

    it("rejects empty-string expected_output_not_contains entry", () => {
      expect(() =>
        validateSkillMeta(
          {
            name: "ok",
            evalCases: [
              { name: "c", input: "x", expectedOutputNotContains: [""] },
            ],
          },
          dirPath,
        ),
      ).toThrow(/non-empty/);
    });

    it("rejects non-string expectation entry", () => {
      expect(() =>
        validateSkillMeta(
          {
            name: "ok",
            evalCases: [
              {
                name: "c",
                input: "x",
                expectedTools: [42 as unknown as string],
              },
            ],
          },
          dirPath,
        ),
      ).toThrow(/entries must be strings/);
    });
  });
});
