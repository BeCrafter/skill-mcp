import { describe, it, expect } from "vitest";
import { requireFilePaths } from "../../../src/http/helpers.js";
import { BadRequestError } from "../../../src/utils/errors.js";

describe("requireFilePaths (T-726)", () => {
  it("returns the array unchanged for a valid input", () => {
    const result = requireFilePaths(["a.md", "b.md"]);
    expect(result).toEqual(["a.md", "b.md"]);
  });

  it("rejects non-array values", () => {
    expect(() => requireFilePaths("a.md")).toThrow(BadRequestError);
    expect(() => requireFilePaths(undefined)).toThrow(BadRequestError);
    expect(() => requireFilePaths({ 0: "a.md" })).toThrow(BadRequestError);
  });

  it("rejects empty array", () => {
    expect(() => requireFilePaths([])).toThrow(/must not be empty/);
  });

  it("rejects arrays longer than 100", () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `file-${i}.md`);
    expect(() => requireFilePaths(tooMany)).toThrow(/exceeds max length/);
  });

  it("accepts exactly 100 entries", () => {
    const exactly = Array.from({ length: 100 }, (_, i) => `file-${i}.md`);
    expect(requireFilePaths(exactly)).toHaveLength(100);
  });

  it("rejects non-string elements (would crash validateFilePath as TypeError)", () => {
    expect(() => requireFilePaths(["a.md", 123])).toThrow(/must contain only strings/);
    expect(() => requireFilePaths([null])).toThrow(/must contain only strings/);
    expect(() => requireFilePaths([{ path: "a.md" }])).toThrow(/must contain only strings/);
  });
});
