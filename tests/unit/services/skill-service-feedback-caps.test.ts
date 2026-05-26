import { describe, it, expect, vi } from "vitest";
import { SkillService } from "../../../src/services/skill.service.js";
import { BadRequestError } from "../../../src/utils/errors.js";
import { createSkillFeedbackTool } from "../../../src/mcp/tools/skill-feedback.js";
import type { ISkillProvider } from "../../../src/provider/interface.js";
import type { ICacheProvider } from "../../../src/cache/provider.interface.js";
import type { Logger } from "pino";
import type { SkillMeta, RequestContext } from "../../../src/types/index.js";

const sampleSkill: SkillMeta = {
  id: "1", slug: "demo", name: "demo",
  displayName: null, description: "",
  version: "0.0.1", category: null, tags: [], attributes: {},
  status: "published", visibility: "public", entryFile: "SKILL.md",
  storagePath: "skills/demo/", contentHash: null,
  createdAt: 1, updatedAt: 1,
};

function mockProvider(): ISkillProvider {
  return {
    listSkills: vi.fn().mockResolvedValue([sampleSkill]),
    getSkillMeta: vi.fn().mockResolvedValue(sampleSkill),
    getSkillMetaById: vi.fn().mockResolvedValue(sampleSkill),
    getSkillEntry: vi.fn().mockResolvedValue(""),
    getSkillFiles: vi.fn().mockResolvedValue([]),
    getSkillFileTree: vi.fn().mockResolvedValue([]),
    skillExists: vi.fn().mockResolvedValue(true),
  };
}

function mockCache(): ICacheProvider {
  return {
    get: vi.fn().mockResolvedValue(null),
    getWithMeta: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    delete: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    clearByPrefix: vi.fn().mockResolvedValue(undefined),
  };
}

function mockLogger(): Logger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(), silent: vi.fn(),
  } as unknown as Logger;
}

function authedCtx(): RequestContext {
  return { userId: "u1", sessionId: "s", tags: new Set(), isAuthenticated: true };
}

describe("submitFeedback length caps (T-727 service-layer backstop)", () => {
  const feedbackRepoStub = { create: vi.fn().mockResolvedValue(undefined) };

  function makeService(): SkillService {
    return new SkillService(
      mockProvider(),
      mockCache(),
      mockLogger(),
      undefined,
      feedbackRepoStub as unknown as never,
    );
  }

  it("rejects context > 2000 chars", async () => {
    const svc = makeService();
    await expect(
      svc.submitFeedback(
        { skill_slug: "demo", outcome: "success", context: "x".repeat(2001), agent_comment: "ok" },
        authedCtx(),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects agent_comment > 8000 chars", async () => {
    const svc = makeService();
    await expect(
      svc.submitFeedback(
        { skill_slug: "demo", outcome: "success", context: "ok", agent_comment: "x".repeat(8001) },
        authedCtx(),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("accepts inputs at the boundary", async () => {
    const svc = makeService();
    await expect(
      svc.submitFeedback(
        { skill_slug: "demo", outcome: "success", context: "x".repeat(2000), agent_comment: "x".repeat(8000) },
        authedCtx(),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("skill_feedback MCP tool zod caps (T-727 boundary)", () => {
  const tool = createSkillFeedbackTool({} as never);

  it("rejects context > 2000 via zod schema", () => {
    const r = tool.inputSchema.safeParse({
      skill_slug: "demo", outcome: "success",
      context: "x".repeat(2001), agent_comment: "ok",
    });
    expect(r.success).toBe(false);
  });

  it("rejects agent_comment > 8000 via zod schema", () => {
    const r = tool.inputSchema.safeParse({
      skill_slug: "demo", outcome: "success",
      context: "ok", agent_comment: "x".repeat(8001),
    });
    expect(r.success).toBe(false);
  });

  it("accepts boundary lengths", () => {
    const r = tool.inputSchema.safeParse({
      skill_slug: "demo", outcome: "success",
      context: "x".repeat(2000), agent_comment: "x".repeat(8000),
    });
    expect(r.success).toBe(true);
  });
});
