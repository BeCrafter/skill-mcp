import { describe, it, expect } from "vitest";
import { buildSkillSystemPrompt } from "../../../../src/mcp/prompt/system-prompt.js"

describe("buildSkillSystemPrompt", () => {
  it("returns a static template that guides the caller to skill_list", () => {
    const prompt = buildSkillSystemPrompt();
    expect(prompt).toContain("扩展技能（Extension Skills，必检）");
    expect(prompt).toContain("skill_list");
    expect(prompt).toContain("skill_view");
    expect(prompt).toContain("skill_file");
  });

  it("does not embed any specific skill slug, name, or description", () => {
    // Regression: previously the prompt enumerated every published skill via
    // an unfiltered listSkills() call, leaking private metadata to anonymous
    // MCP callers. The catalog now lives in skill_list (RBAC-filtered), so
    // the static instructions must not contain a per-skill block at all.
    const prompt = buildSkillSystemPrompt();
    expect(prompt).not.toContain("<available_skills>");
    expect(prompt).not.toContain("</available_skills>");
    expect(prompt).not.toContain("[Available tags:");
  });

  it("is deterministic — repeated calls produce identical output", () => {
    expect(buildSkillSystemPrompt()).toBe(buildSkillSystemPrompt());
  });
});
