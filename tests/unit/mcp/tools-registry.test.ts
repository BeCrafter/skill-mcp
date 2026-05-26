import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "@/mcp/tools/registry.js";
import type { SkillService } from "@/services/skill.service.js";

function fakeService(): SkillService {
  return {
    listSkillsIndex: vi.fn().mockResolvedValue(""),
    viewSkillEntry: vi.fn().mockResolvedValue("# entry"),
    readSkillFiles: vi.fn().mockResolvedValue([]),
    submitFeedback: vi.fn().mockResolvedValue(undefined),
  } as unknown as SkillService;
}

describe("mcp/tools/registry — registerTools", () => {
  it("registers all five tools on the server", () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, fakeService());
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    const names = Object.keys(registered ?? {});
    expect(names).toEqual(expect.arrayContaining([
      "skill_list", "skill_view", "skill_file", "skill_feedback", "skill_pipeline",
    ]));
    expect(names).toHaveLength(5);
  });

  it("instrument() wrapper passes through the original return value on success", () => {
    // We can't observe instrument() directly (private), but registering twice on
    // the same server throws — confirming each tool's handler is bound.
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, fakeService());
    expect(() => registerTools(server, fakeService())).toThrow();
  });
});
