import { describe, it, expect } from "vitest";
import { toSkillMetaPublic } from "@/types/index.js";
import type { SkillMeta } from "@/types/index.js";

const internal: SkillMeta = {
  id: "1",
  slug: "demo",
  name: "demo",
  displayName: null,
  description: "d",
  version: "0.0.1",
  category: null,
  tags: [],
  attributes: {},
  status: "published",
  visibility: "public",
  entryFile: "SKILL.md",
  storagePath: "skills/demo/",
  contentHash: "deadbeef",
  createdAt: 1,
  updatedAt: 1,
};

describe("toSkillMetaPublic (T-302)", () => {
  it("strips storagePath and contentHash from the output", () => {
    const pub = toSkillMetaPublic(internal);
    expect(pub).not.toHaveProperty("storagePath");
    expect(pub).not.toHaveProperty("contentHash");
  });

  it("preserves all other public fields verbatim", () => {
    const pub = toSkillMetaPublic(internal);
    expect(pub.id).toBe(internal.id);
    expect(pub.slug).toBe(internal.slug);
    expect(pub.name).toBe(internal.name);
    expect(pub.version).toBe(internal.version);
    expect(pub.visibility).toBe(internal.visibility);
    expect(pub.status).toBe(internal.status);
    expect(pub.tags).toBe(internal.tags);
    expect(pub.attributes).toBe(internal.attributes);
    expect(pub.entryFile).toBe(internal.entryFile);
  });

  it("does not mutate the input", () => {
    toSkillMetaPublic(internal);
    expect(internal.storagePath).toBe("skills/demo/");
    expect(internal.contentHash).toBe("deadbeef");
  });

  it("JSON.stringify produces a payload with no leaked internal fields", () => {
    const json = JSON.stringify(toSkillMetaPublic(internal));
    expect(json).not.toContain("storagePath");
    expect(json).not.toContain("contentHash");
    expect(json).not.toContain("skills/demo/");
    expect(json).not.toContain("deadbeef");
  });
});
