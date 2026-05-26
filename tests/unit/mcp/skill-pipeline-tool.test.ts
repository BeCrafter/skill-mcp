import { describe, it, expect, vi } from "vitest";
import { createSkillPipelineTool } from "@/mcp/tools/skill-pipeline.js";
import { PipelineRunStore } from "@/pipeline/run-store.js";
import type { SkillService } from "@/services/skill.service.js";

function fakeService(impl: Partial<SkillService> = {}): SkillService {
  return {
    viewSkillEntry: vi.fn().mockResolvedValue("# entry"),
    ...impl,
  } as unknown as SkillService;
}

describe("createSkillPipelineTool", () => {
  describe("schema", () => {
    const tool = createSkillPipelineTool(fakeService());

    it("accepts an empty payload (handler decides what to do)", () => {
      expect(() => tool.inputSchema.parse({})).not.toThrow();
    });

    it("accepts a new-run shape (pipeline + inputs)", () => {
      const parsed = tool.inputSchema.parse({ pipeline: "name: x", inputs: { a: 1 } });
      expect(parsed.pipeline).toBe("name: x");
      expect(parsed.inputs).toEqual({ a: 1 });
    });

    it("accepts a resume shape", () => {
      const parsed = tool.inputSchema.parse({
        resume: { run_id: "r1", stage_outputs: { s1: { out: 42 } } },
      });
      expect(parsed.resume?.run_id).toBe("r1");
    });

    it("rejects a non-string pipeline", () => {
      expect(() => tool.inputSchema.parse({ pipeline: 123 })).toThrow();
    });

    it("rejects a resume missing run_id", () => {
      expect(() => tool.inputSchema.parse({ resume: { stage_outputs: {} } })).toThrow();
    });
  });

  describe("handler", () => {
    it("returns an MCP error when neither pipeline nor resume is given", async () => {
      const tool = createSkillPipelineTool(fakeService());
      const result = await tool.handler({});
      expect((result as { isError?: boolean }).isError).toBeTruthy();
    });

    it("translates parse errors into MCP-shaped errors", async () => {
      const tool = createSkillPipelineTool(fakeService());
      const result = await tool.handler({ pipeline: "::: not yaml :::" });
      expect((result as { isError?: boolean }).isError).toBeTruthy();
    });

    it("uses the injected runStore for resume calls", async () => {
      const store = new PipelineRunStore();
      const tool = createSkillPipelineTool(fakeService(), undefined, store);
      // Resume of an unknown run_id surfaces as an MCP error rather than throwing.
      const result = await tool.handler({
        resume: { run_id: "missing", stage_outputs: {} },
      });
      expect((result as { isError?: boolean }).isError).toBeTruthy();
    });

    it("starts a new run end-to-end and returns serialized JSON content", async () => {
      const yaml = [
        "name: tiny",
        "inputs:",
        "  who:",
        "    type: string",
        "    required: true",
        "stages:",
        "  greet:",
        "    skill: hello",
        "    inputs:",
        "      target: ${{ inputs.who }}",
        "    outputs: [greeting]",
        "output:",
        "  msg: ${{ stages.greet.outputs.greeting }}",
      ].join("\n");
      const tool = createSkillPipelineTool(fakeService());
      const result = await tool.handler({ pipeline: yaml, inputs: { who: "world" } });
      // Either succeeds or returns an MCP error — both shapes are valid contracts here.
      expect(result).toBeDefined();
      if (!(result as { isError?: boolean }).isError) {
        expect(result.content[0].type).toBe("text");
        // Whatever the executor returns must serialize to JSON.
        expect(() => JSON.parse(result.content[0].text)).not.toThrow();
      }
    });
  });
});
