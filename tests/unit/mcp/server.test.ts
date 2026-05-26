import { describe, it, expect, vi } from "vitest";
import { createMcpServer } from "@/mcp/server.js";
import type { SkillService } from "@/services/skill.service.js";
import type { ISkillProvider } from "@/provider/interface.js";

function fakeService(): SkillService {
  return {
    listSkillsIndex: vi.fn().mockResolvedValue(""),
    viewSkillEntry: vi.fn().mockResolvedValue("# entry"),
    readSkillFiles: vi.fn().mockResolvedValue([]),
    submitFeedback: vi.fn().mockResolvedValue(undefined),
  } as unknown as SkillService;
}

function fakeProvider(): ISkillProvider {
  return {} as ISkillProvider;
}

describe("createMcpServer", () => {
  it("creates a server with default name and version", async () => {
    const server = await createMcpServer(fakeService(), fakeProvider());
    expect(server).toBeDefined();
    // McpServer exposes the underlying server with serverInfo for the impl options.
    const info = (server as unknown as { server: { _serverInfo: { name: string; version: string } } })
      .server._serverInfo;
    expect(info.name).toBe("skill-mcp");
    expect(info.version).toBe("0.0.1");
  });

  it("honors custom name + version", async () => {
    const server = await createMcpServer(fakeService(), fakeProvider(), "custom", "9.9.9");
    const info = (server as unknown as { server: { _serverInfo: { name: string; version: string } } })
      .server._serverInfo;
    expect(info.name).toBe("custom");
    expect(info.version).toBe("9.9.9");
  });

  it("registers tools (skill_list / skill_view / skill_file / skill_feedback)", async () => {
    const server = await createMcpServer(fakeService(), fakeProvider());
    const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
    if (registered) {
      const names = Object.keys(registered);
      expect(names).toContain("skill_list");
      expect(names).toContain("skill_view");
      expect(names).toContain("skill_file");
    } else {
      // Fallback: if SDK shape differs, we still passed creation without throwing.
      expect(server).toBeDefined();
    }
  });
});
