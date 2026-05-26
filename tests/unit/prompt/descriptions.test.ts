import { describe, it, expect } from "vitest";
import {
  SKILL_LIST_DESC,
  SKILL_VIEW_DESC,
  SKILL_FILE_DESC,
  SKILL_FEEDBACK_DESC,
} from "@/prompt/descriptions.js";

describe("prompt/descriptions", () => {
  it("SKILL_LIST_DESC documents call-conditions and the tag-filter signature", () => {
    expect(SKILL_LIST_DESC).toMatch(/MUST call this tool/);
    expect(SKILL_LIST_DESC).toMatch(/skill_list\(\{tags:/);
    expect(SKILL_LIST_DESC).toMatch(/system-reminder/);
  });

  it("SKILL_VIEW_DESC requires skill_list discovery first and accepts slug or id", () => {
    expect(SKILL_VIEW_DESC).toMatch(/skill_list/);
    expect(SKILL_VIEW_DESC).toMatch(/skill_view\(skill_slug\)/);
    expect(SKILL_VIEW_DESC).toMatch(/skill_view\(skill_id\)/);
  });

  it("SKILL_FILE_DESC names the prerequisite (skill_view) and the encoding contract", () => {
    expect(SKILL_FILE_DESC).toMatch(/skill_view first/);
    expect(SKILL_FILE_DESC).toMatch(/base64/);
    expect(SKILL_FILE_DESC).toMatch(/Do not proactively browse/);
  });

  it("SKILL_FEEDBACK_DESC includes a concrete usage example", () => {
    expect(SKILL_FEEDBACK_DESC).toMatch(/skill_feedback\(\{/);
    expect(SKILL_FEEDBACK_DESC).toMatch(/outcome:/);
    expect(SKILL_FEEDBACK_DESC).toMatch(/context:/);
    expect(SKILL_FEEDBACK_DESC).toMatch(/agent_comment:/);
  });

  it("each description is a non-empty multi-line string", () => {
    for (const d of [SKILL_LIST_DESC, SKILL_VIEW_DESC, SKILL_FILE_DESC, SKILL_FEEDBACK_DESC]) {
      expect(typeof d).toBe("string");
      expect(d.length).toBeGreaterThan(50);
      expect(d).toContain("\n");
    }
  });
});
