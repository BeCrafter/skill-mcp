import { describe, it, expect } from "vitest";
import {
  SkillNotFoundError,
  PermissionDeniedError,
  DuplicateSkillNameError,
  SecurityError,
  ContentUnchangedError,
  toMcpError,
} from "../../../src/utils/errors.js";

describe("SkillNotFoundError", () => {
  it("should have correct properties", () => {
    const err = new SkillNotFoundError("test-skill");
    expect(err.message).toContain("test-skill");
    expect(err.code).toBe("SKILL_NOT_FOUND");
  });
});

describe("DuplicateSkillNameError", () => {
  it("should list existing skills", () => {
    const err = new DuplicateSkillNameError("prompt-writer", [
      { slug: "prompt-writer", version: "1.0.0" },
      { slug: "prompt-writer-v2", version: "2.0.0" },
    ]);
    expect(err.message).toContain("prompt-writer");
    expect(err.message).toContain("prompt-writer-v2");
  });
});

describe("toMcpError", () => {
  it("should format Error to MCP response", () => {
    const err = new Error("test error");
    const result = toMcpError(err);
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("test error");
  });

  it("should format string to MCP response", () => {
    const result = toMcpError("string error");
    expect(result.isError).toBe(true);
  });
});
