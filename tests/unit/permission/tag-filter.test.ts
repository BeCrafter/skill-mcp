import { describe, it, expect } from "vitest";
import { TagPermissionFilter } from "../../../src/permission/tag-filter.js";
import type { SkillMeta, RequestContext } from "../../../src/types/index.js";

function skill(overrides: Partial<SkillMeta>): SkillMeta {
  return {
    id: "1", slug: "s", name: "s", displayName: null, description: "",
    version: "0.0.1", category: null, tags: [], attributes: {},
    status: "published", visibility: "private", entryFile: "SKILL.md",
    storagePath: "s/", contentHash: null,
    createdAt: 0, updatedAt: 0, ...overrides,
  };
}

function ctx(overrides: Partial<RequestContext>): RequestContext {
  return {
    userId: "anonymous", sessionId: "x", tags: new Set<string>(),
    isAuthenticated: false, ...overrides,
  };
}

describe("TagPermissionFilter visibility gate", () => {
  it("public skills are visible to anonymous callers", async () => {
    const filter = new TagPermissionFilter(ctx({}));
    const out = await filter.filter([skill({ visibility: "public", tags: ["any"] })]);
    expect(out).toHaveLength(1);
  });

  it("private skills are hidden from anonymous callers", async () => {
    const filter = new TagPermissionFilter(ctx({}));
    const out = await filter.filter([skill({ visibility: "private" })]);
    expect(out).toHaveLength(0);
  });

  it("internal skills are hidden from anonymous callers", async () => {
    const filter = new TagPermissionFilter(ctx({}));
    const out = await filter.filter([skill({ visibility: "internal" })]);
    expect(out).toHaveLength(0);
  });

  it("internal skills are visible to any authenticated user (no tag check)", async () => {
    const filter = new TagPermissionFilter(ctx({
      userId: "u1", isAuthenticated: true, tags: new Set(),
    }));
    const out = await filter.filter([skill({ visibility: "internal", tags: ["x"] })]);
    expect(out).toHaveLength(1);
  });

  it("private skills with empty tags are visible to any authenticated user", async () => {
    const filter = new TagPermissionFilter(ctx({
      userId: "u1", isAuthenticated: true, tags: new Set(),
    }));
    const out = await filter.filter([skill({ visibility: "private", tags: [] })]);
    expect(out).toHaveLength(1);
  });

  it("private skills with tags require tag intersection", async () => {
    const filter = new TagPermissionFilter(ctx({
      userId: "u1", isAuthenticated: true, tags: new Set(["frontend"]),
    }));
    const matching = skill({ slug: "fe", visibility: "private", tags: ["frontend"] });
    const blocked = skill({ slug: "be", visibility: "private", tags: ["backend"] });
    const out = await filter.filter([matching, blocked]);
    expect(out.map(s => s.slug)).toEqual(["fe"]);
  });
});

describe("TagPermissionFilter lifecycle gate (P0-9)", () => {
  it("hides draft skills from non-admin authenticated callers", async () => {
    const filter = new TagPermissionFilter(ctx({
      userId: "u1", isAuthenticated: true, tags: new Set(),
    }));
    const out = await filter.filter([skill({ visibility: "public", status: "draft" })]);
    expect(out).toHaveLength(0);
  });

  it("hides archived skills from non-admin callers", async () => {
    const filter = new TagPermissionFilter(ctx({
      userId: "u1", isAuthenticated: true, tags: new Set(),
    }));
    const out = await filter.filter([skill({ visibility: "public", status: "archived" })]);
    expect(out).toHaveLength(0);
  });

  it("keeps deprecated skills visible (soft-retire window)", async () => {
    const filter = new TagPermissionFilter(ctx({
      userId: "u1", isAuthenticated: true, tags: new Set(),
    }));
    const out = await filter.filter([skill({ visibility: "public", status: "deprecated" })]);
    expect(out).toHaveLength(1);
  });

  it("userType=admin bypasses the lifecycle filter and sees drafts", async () => {
    const filter = new TagPermissionFilter(ctx({
      userId: "admin", isAuthenticated: true, userType: "admin", tags: new Set(),
    }));
    const out = await filter.filter([
      skill({ slug: "d", visibility: "private", status: "draft" }),
      skill({ slug: "a", visibility: "private", status: "archived" }),
    ]);
    expect(out.map(s => s.slug).sort()).toEqual(["a", "d"]);
  });

  it("userType=superadmin also bypasses the lifecycle filter", async () => {
    const filter = new TagPermissionFilter(ctx({
      userId: "sa", isAuthenticated: true, userType: "superadmin", tags: new Set(),
    }));
    const out = await filter.filter([skill({ visibility: "public", status: "draft" })]);
    expect(out).toHaveLength(1);
  });

  it("userType=user does NOT bypass the lifecycle filter", async () => {
    const filter = new TagPermissionFilter(ctx({
      userId: "u1", isAuthenticated: true, userType: "user", tags: new Set(),
    }));
    const out = await filter.filter([skill({ visibility: "public", status: "draft" })]);
    expect(out).toHaveLength(0);
  });

  it("anonymous caller does NOT pick up admin bypass even with userType set", async () => {
    // Sanity: isAuthenticated=false means isAdmin() short-circuits to false.
    const filter = new TagPermissionFilter(ctx({
      userType: "admin", isAuthenticated: false, tags: new Set(),
    }));
    const out = await filter.filter([skill({ visibility: "public", status: "draft" })]);
    expect(out).toHaveLength(0);
  });
});
