import { describe, it, expect } from "vitest";
import {
  SkillNotFoundError,
  PermissionDeniedError,
  DuplicateSkillNameError,
  SecurityError,
  ContentUnchangedError,
  ConfigurationError,
  VersionNotFoundError,
  BadRequestError,
  mapErrorToResponse,
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
      { slug: "prompt-writer", version: "0.0.1" },
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

describe("New error subclasses (T-201)", () => {
  it("ConfigurationError → 500 / CONFIGURATION_ERROR", () => {
    const err = new ConfigurationError("repo missing");
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe("CONFIGURATION_ERROR");
  });

  it("VersionNotFoundError → 404 / VERSION_NOT_FOUND", () => {
    const err = new VersionNotFoundError("demo", "1.0.0");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("VERSION_NOT_FOUND");
    expect(err.message).toContain("demo");
    expect(err.message).toContain("1.0.0");
  });

  it("BadRequestError → 400 / BAD_REQUEST", () => {
    const err = new BadRequestError("paths must be an array");
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("BAD_REQUEST");
  });
});

describe("mapErrorToResponse (T-201)", () => {
  it("maps SkillNotFoundError to 404 with code", () => {
    const { status, body } = mapErrorToResponse(new SkillNotFoundError("missing"));
    expect(status).toBe(404);
    expect(body.code).toBe("SKILL_NOT_FOUND");
    expect(body.success).toBe(false);
    expect(body.error).toContain("missing");
  });

  it("maps PermissionDeniedError to 403", () => {
    const { status, body } = mapErrorToResponse(new PermissionDeniedError("private-skill"));
    expect(status).toBe(403);
    expect(body.code).toBe("PERMISSION_DENIED");
  });

  it("maps DuplicateSkillNameError to 409", () => {
    const { status, body } = mapErrorToResponse(
      new DuplicateSkillNameError("dup", [{ slug: "dup", version: "1.0.0" }]),
    );
    expect(status).toBe(409);
    expect(body.code).toBe("DUPLICATE_SKILL_NAME");
  });

  it("maps SecurityError to 400", () => {
    const { status, body } = mapErrorToResponse(new SecurityError(["bad"]));
    expect(status).toBe(400);
    expect(body.code).toBe("SECURITY_VIOLATION");
  });

  it("maps ContentUnchangedError to 400", () => {
    const { status, body } = mapErrorToResponse(new ContentUnchangedError("demo"));
    expect(status).toBe(400);
    expect(body.code).toBe("CONTENT_UNCHANGED");
  });

  it("maps ConfigurationError to 500", () => {
    const { status, body } = mapErrorToResponse(new ConfigurationError("missing dep"));
    expect(status).toBe(500);
    expect(body.code).toBe("CONFIGURATION_ERROR");
  });

  it("maps generic Error to 500 without code", () => {
    const { status, body } = mapErrorToResponse(new Error("boom"));
    expect(status).toBe(500);
    expect(body.code).toBeUndefined();
    expect(body.error).toBe("boom");
  });

  it("uses fallback message for empty Error", () => {
    const { status, body } = mapErrorToResponse(new Error(""), "fallback message");
    expect(status).toBe(500);
    expect(body.error).toBe("fallback message");
  });

  it("maps non-Error throws to 500 with stringified value", () => {
    const { status, body } = mapErrorToResponse("just a string");
    expect(status).toBe(500);
    expect(body.error).toBe("just a string");
  });
});
