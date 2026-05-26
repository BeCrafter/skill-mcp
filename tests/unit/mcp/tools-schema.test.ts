import { describe, it, expect, vi } from "vitest";
import { createSkillListTool } from "../../../src/mcp/tools/skill-list.js";
import { createSkillViewTool } from "../../../src/mcp/tools/skill-view.js";
import { createSkillFileTool } from "../../../src/mcp/tools/skill-file.js";
import { createSkillFeedbackTool } from "../../../src/mcp/tools/skill-feedback.js";
import type { SkillService } from "../../../src/services/skill.service.js";

function fakeService(): SkillService {
  return {
    listSkillsIndex: vi.fn().mockResolvedValue("- demo: hello"),
    viewSkillEntry: vi.fn().mockResolvedValue("# entry"),
    readSkillFiles: vi.fn().mockResolvedValue([{ filePath: "a.md", content: "x", encoding: "utf-8" }]),
    submitFeedback: vi.fn().mockResolvedValue(undefined),
  } as unknown as SkillService;
}

describe("MCP tool schemas", () => {
  describe("skill_list", () => {
    const tool = createSkillListTool(fakeService());

    it("schema accepts {} (no tags)", () => {
      expect(tool.inputSchema.parse({}).tags).toBeUndefined();
    });

    it("schema accepts a string array of tags", () => {
      expect(tool.inputSchema.parse({ tags: ["a", "b"] }).tags).toEqual(["a", "b"]);
    });

    it("schema rejects a non-array tags value", () => {
      expect(() => tool.inputSchema.parse({ tags: "single" })).toThrow();
    });

    it("schema rejects non-string elements inside tags", () => {
      expect(() => tool.inputSchema.parse({ tags: [42] })).toThrow();
    });

    it("handler returns the list-style content with header", async () => {
      const result = await tool.handler({});
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toMatch(/Extension Skills/);
    });

    it("handler renders the empty fallback when listSkillsIndex returns empty", async () => {
      const svc = { listSkillsIndex: vi.fn().mockResolvedValue("") } as unknown as SkillService;
      const t = createSkillListTool(svc);
      const result = await t.handler({});
      expect(result.content[0].text).toMatch(/当前没有可用的扩展技能/);
    });
  });

  describe("skill_view", () => {
    const tool = createSkillViewTool(fakeService());

    it("returns an MCP error when neither skill_slug nor skill_id is given", async () => {
      const result = await tool.handler({});
      expect(result.isError ?? (result as { isError?: boolean }).isError).toBeTruthy();
    });

    it("prefers skill_id over skill_slug", async () => {
      const view = vi.fn().mockResolvedValue("# from id");
      const svc = { viewSkillEntry: view } as unknown as SkillService;
      const t = createSkillViewTool(svc);
      await t.handler({ skill_id: "uuid-1", skill_slug: "demo" });
      expect(view).toHaveBeenCalledWith("uuid-1", undefined);
    });

    it("falls back to skill_slug when no skill_id is given", async () => {
      const view = vi.fn().mockResolvedValue("# from slug");
      const svc = { viewSkillEntry: view } as unknown as SkillService;
      const t = createSkillViewTool(svc);
      await t.handler({ skill_slug: "demo" });
      expect(view).toHaveBeenCalledWith("demo", undefined);
    });

    it("translates service errors into MCP-shaped errors instead of throwing", async () => {
      const svc = { viewSkillEntry: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as SkillService;
      const t = createSkillViewTool(svc);
      const result = await t.handler({ skill_slug: "demo" });
      expect((result as { isError?: boolean }).isError).toBeTruthy();
    });
  });

  describe("skill_file", () => {
    const tool = createSkillFileTool(fakeService());

    it("schema requires file_paths", () => {
      expect(() => tool.inputSchema.parse({})).toThrow();
    });

    it("schema accepts file_paths-only payload (no skill identifier)", () => {
      expect(tool.inputSchema.parse({ file_paths: ["a.md"] }).file_paths).toEqual(["a.md"]);
    });

    it("returns text content for utf-8 files and image content for base64", async () => {
      const svc = {
        readSkillFiles: vi.fn().mockResolvedValue([
          { filePath: "a.md", content: "hello", encoding: "utf-8" },
          { filePath: "logo.png", content: "BASE64DATA", encoding: "base64", mimeType: "image/png" },
        ]),
      } as unknown as SkillService;
      const t = createSkillFileTool(svc);
      const result = await t.handler({ skill_slug: "demo", file_paths: ["a.md", "logo.png"] });
      expect(result.content[0]).toMatchObject({ type: "text", text: "hello" });
      expect(result.content[1]).toMatchObject({ type: "image", data: "BASE64DATA", mimeType: "image/png" });
    });

    it("MCP-error response when no identifier is given", async () => {
      const result = await tool.handler({ file_paths: ["a.md"] });
      expect((result as { isError?: boolean }).isError).toBeTruthy();
    });
  });

  describe("skill_feedback", () => {
    const tool = createSkillFeedbackTool(fakeService());

    it("schema requires all four fields", () => {
      expect(() => tool.inputSchema.parse({})).toThrow();
    });

    it("schema enforces outcome enum values", () => {
      expect(() => tool.inputSchema.parse({
        skill_slug: "demo", outcome: "great", context: "c", agent_comment: "ac",
      })).toThrow();
    });

    it("T-727: schema rejects oversized context (>2000)", () => {
      expect(() => tool.inputSchema.parse({
        skill_slug: "demo", outcome: "success",
        context: "x".repeat(2001), agent_comment: "ok",
      })).toThrow();
    });

    it("T-727: schema rejects oversized agent_comment (>8000)", () => {
      expect(() => tool.inputSchema.parse({
        skill_slug: "demo", outcome: "success",
        context: "ok", agent_comment: "x".repeat(8001),
      })).toThrow();
    });

    it("T-727: schema rejects oversized skill_slug (>255)", () => {
      expect(() => tool.inputSchema.parse({
        skill_slug: "x".repeat(256), outcome: "success", context: "c", agent_comment: "ac",
      })).toThrow();
    });

    it("handler delegates to submitFeedback and returns ack text", async () => {
      const submit = vi.fn().mockResolvedValue(undefined);
      const svc = { submitFeedback: submit } as unknown as SkillService;
      const t = createSkillFeedbackTool(svc);
      const result = await t.handler({
        skill_slug: "demo", outcome: "success", context: "c", agent_comment: "ac",
      });
      expect(submit).toHaveBeenCalled();
      expect(result.content[0].text).toMatch(/demo.*success/);
    });

    it("handler returns MCP error when submitFeedback throws", async () => {
      const svc = { submitFeedback: vi.fn().mockRejectedValue(new Error("nope")) } as unknown as SkillService;
      const t = createSkillFeedbackTool(svc);
      const result = await t.handler({
        skill_slug: "demo", outcome: "success", context: "c", agent_comment: "ac",
      });
      expect((result as { isError?: boolean }).isError).toBeTruthy();
    });
  });
});
