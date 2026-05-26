import { describe, it, expect, vi } from "vitest";
import { parsePipeline } from "../../../src/pipeline/parser.js";

describe("parsePipeline", () => {
  it("parses a minimal valid pipeline", () => {
    const yaml = `
name: demo
stages:
  s1:
    skill: writer
    inputs: {}
    outputs: [text]
`;
    const def = parsePipeline(yaml);
    expect(def.name).toBe("demo");
    expect(Object.keys(def.stages)).toEqual(["s1"]);
    expect(def.stages.s1.skill).toBe("writer");
    expect(def.stages.s1.outputs).toEqual(["text"]);
    expect(def.stages.s1.inputs).toEqual({});
  });

  it("parses inputs / output / description / depends_on", () => {
    const yaml = `
name: full
description: a full pipeline
inputs:
  topic:
    type: string
    required: true
  draft:
    type: string
    default: hello
stages:
  a:
    skill: writer
    inputs:
      t: \${{ inputs.topic }}
    outputs: [text]
  b:
    skill: reviewer
    depends_on: [a]
    inputs:
      raw: \${{ stages.a.outputs.text }}
    outputs: [verdict]
output:
  final: \${{ stages.b.outputs.verdict }}
`;
    const def = parsePipeline(yaml);
    expect(def.description).toBe("a full pipeline");
    expect(def.inputs.topic).toEqual({ type: "string", required: true, default: undefined });
    expect(def.inputs.draft.default).toBe("hello");
    expect(def.stages.b.depends_on).toEqual(["a"]);
    expect(def.output.final).toBe("${{ stages.b.outputs.verdict }}");
  });

  it("rejects YAML scalars / nullish docs at root", () => {
    expect(() => parsePipeline("plain string")).toThrow(/must be an object/);
    // An empty doc parses to `null`, which fails the falsy check first.
    expect(() => parsePipeline("")).toThrow(/must be an object/);
  });

  it("rejects pipeline without name", () => {
    expect(() => parsePipeline("stages: {}\n")).toThrow(/Pipeline name is required/);
  });

  it("rejects pipeline without stages", () => {
    expect(() => parsePipeline("name: x\n")).toThrow(/must have stages/);
  });

  it("rejects stage without skill", () => {
    const yaml = `
name: x
stages:
  s1:
    inputs: {}
    outputs: [a]
`;
    expect(() => parsePipeline(yaml)).toThrow(/must specify a skill/);
  });

  it("rejects stage without outputs array", () => {
    const yaml = `
name: x
stages:
  s1:
    skill: foo
    inputs: {}
`;
    expect(() => parsePipeline(yaml)).toThrow(/must define outputs array/);
  });

  it("rejects stage without inputs object", () => {
    const yaml = `
name: x
stages:
  s1:
    skill: foo
    outputs: [a]
`;
    expect(() => parsePipeline(yaml)).toThrow(/must have inputs object/);
  });

  it("rejects non-object stage value", () => {
    const yaml = `
name: x
stages:
  s1: "string-not-object"
`;
    expect(() => parsePipeline(yaml)).toThrow(/must be an object/);
  });

  it("warns on deprecated condition / retry fields (T-203)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const yaml = `
name: x
stages:
  s1:
    skill: foo
    inputs: {}
    outputs: [a]
    condition: \${{ inputs.go }}
    retry: 3
`;
    const def = parsePipeline(yaml);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/condition.*retry.*ignored/i));
    // Crucially, the parsed StageDefinition strips them — executor must not see them.
    expect(def.stages.s1).not.toHaveProperty("condition");
    expect(def.stages.s1).not.toHaveProperty("retry");
    warn.mockRestore();
  });

  it("wraps YAML syntax errors with the 'Failed to parse pipeline' prefix", () => {
    expect(() => parsePipeline(": : :")).toThrow(/Failed to parse pipeline/);
  });

  it("input.type defaults to 'string' when omitted", () => {
    const yaml = `
name: x
inputs:
  q: {}
stages:
  s1:
    skill: foo
    inputs: {}
    outputs: [a]
`;
    const def = parsePipeline(yaml);
    expect(def.inputs.q.type).toBe("string");
  });

  it("ignores non-string output entries", () => {
    const yaml = `
name: x
stages:
  s1:
    skill: foo
    inputs: {}
    outputs: [a]
output:
  good: \${{ stages.s1.outputs.a }}
  bad: 42
  also_bad:
    nested: 1
`;
    const def = parsePipeline(yaml);
    expect(def.output).toEqual({ good: "${{ stages.s1.outputs.a }}" });
  });
});
