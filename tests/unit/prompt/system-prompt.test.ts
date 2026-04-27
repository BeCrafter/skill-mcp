import { describe, it, expect } from "vitest";
import { buildSkillSystemPrompt } from "../../../src/prompt/system-prompt.js";
import type { SkillMeta } from "../../../src/types/index.js";

describe("buildSkillSystemPrompt", () => {
  it("should build prompt with skills", () => {
    const skills: SkillMeta[] = [
      {
        id: "1",
        slug: "prompt-writer",
        name: "prompt-writer",
        displayName: null,
        description: "Professional prompt writing",
        version: "1.0.0",
        category: null,
        tags: [],
        attributes: {},
        status: "published",
        visibility: "public",
        entryFile: "SKILL.md",
        storagePath: "skills/prompt-writer/",
        contentHash: null,
        conditions: null,
        assignedGroups: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    const prompt = buildSkillSystemPrompt(skills);
    expect(prompt).toContain("Cloud Skills (mandatory)");
    expect(prompt).toContain("prompt-writer");
    expect(prompt).toContain("Professional prompt writing");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("</available_skills>");
  });

  it("should filter to published only", () => {
    const skills: SkillMeta[] = [
      {
        id: "1",
        slug: "draft-skill",
        name: "draft-skill",
        displayName: null,
        description: "A draft skill",
        version: "1.0.0",
        category: null,
        tags: [],
        attributes: {},
        status: "draft",
        visibility: "public",
        entryFile: "SKILL.md",
        storagePath: "skills/draft/",
        contentHash: null,
        conditions: null,
        assignedGroups: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    const prompt = buildSkillSystemPrompt(skills);
    expect(prompt).not.toContain("draft-skill");
  });

  it("should handle empty skills list", () => {
    const prompt = buildSkillSystemPrompt([]);
    expect(prompt).toContain("No skills are currently available");
  });
});
