import { describe, it, expect } from "vitest";
import { ExecutionContext } from "@/pipeline/context.js";
import { DAGScheduler } from "@/pipeline/dag.js";
import type { StageDefinition } from "@/pipeline/types.js";

describe("ExecutionContext.resolveExpressions (T-203)", () => {
  it("preserves native types for whole-string expressions", () => {
    const ctx = new ExecutionContext({ count: 42, list: ["a", "b"] });
    expect(ctx.resolveExpressions("${{ inputs.count }}")).toBe(42);
    expect(ctx.resolveExpressions("${{ inputs.list }}")).toEqual(["a", "b"]);
  });

  it("supports embedded ${{ }} substitution within larger strings", () => {
    const ctx = new ExecutionContext({ user_id: "u-123", env: "prod" });
    expect(ctx.resolveExpressions("https://example.com/${{ inputs.user_id }}/profile"))
      .toBe("https://example.com/u-123/profile");
    expect(ctx.resolveExpressions("[${{ inputs.env }}] hello ${{ inputs.user_id }}!"))
      .toBe("[prod] hello u-123!");
  });

  it("stringifies non-string values when embedded inline", () => {
    const ctx = new ExecutionContext({ n: 7, obj: { a: 1 } });
    expect(ctx.resolveExpressions("count=${{ inputs.n }}")).toBe("count=7");
    expect(ctx.resolveExpressions("data=${{ inputs.obj }}")).toBe('data={"a":1}');
  });

  it("recurses into objects and arrays", () => {
    const ctx = new ExecutionContext({ x: "y" });
    expect(ctx.resolveExpressions({ url: "/${{ inputs.x }}", nested: ["a", "b-${{ inputs.x }}"] }))
      .toEqual({ url: "/y", nested: ["a", "b-y"] });
  });

  it("leaves plain strings without ${{ }} untouched", () => {
    const ctx = new ExecutionContext({});
    expect(ctx.resolveExpressions("plain")).toBe("plain");
  });

  it("throws on unknown prefix or malformed inputs path", () => {
    const ctx = new ExecutionContext({ k: 1 });
    expect(() => ctx.resolveExpressions("${{ unknown.x }}")).toThrow(/unknown prefix/);
    expect(() => ctx.resolveExpressions("${{ inputs.a.b }}")).toThrow(/expected inputs.key/);
  });

  it("renders missing inputs as empty string when embedded", () => {
    const ctx = new ExecutionContext({});
    expect(ctx.resolveExpressions("v=${{ inputs.missing }}!")).toBe("v=!");
  });
});

describe("DAGScheduler cycle detection", () => {
  it("rejects a → b → a cycle", () => {
    const stages: Record<string, StageDefinition> = {
      a: { skill: "x", depends_on: ["b"], inputs: {}, outputs: [] },
      b: { skill: "x", depends_on: ["a"], inputs: {}, outputs: [] },
    };
    expect(() => new DAGScheduler(stages).getBatches()).toThrow(/[Cc]ircular/);
  });

  it("rejects a self-loop", () => {
    const stages: Record<string, StageDefinition> = {
      a: { skill: "x", depends_on: ["a"], inputs: {}, outputs: [] },
    };
    expect(() => new DAGScheduler(stages).getBatches()).toThrow(/[Cc]ircular/);
  });

  it("rejects a depends_on referencing unknown stage", () => {
    const stages: Record<string, StageDefinition> = {
      a: { skill: "x", depends_on: ["ghost"], inputs: {}, outputs: [] },
    };
    expect(() => new DAGScheduler(stages)).toThrow(/unknown stage/);
  });
});

describe("ExecutionContext path safety (T-502)", () => {
  it("rejects __proto__ in inputs path", () => {
    const ctx = new ExecutionContext({ x: 1 });
    expect(() => ctx.resolveExpressions("${{ inputs.__proto__ }}"))
      .toThrow(/unsafe path segment/);
  });

  it("rejects constructor in stages outputs path", () => {
    const ctx = new ExecutionContext({});
    ctx.setStageOutputs("a", { foo: "bar" });
    expect(() => ctx.resolveExpressions("${{ stages.a.outputs.constructor }}"))
      .toThrow(/unsafe path segment/);
  });

  it("rejects prototype-walking in stage name segment", () => {
    const ctx = new ExecutionContext({});
    expect(() => ctx.resolveExpressions("${{ stages.__proto__.outputs.x }}"))
      .toThrow(/unsafe path segment/);
  });

  it("rejects empty path segments", () => {
    const ctx = new ExecutionContext({ x: 1 });
    expect(() => ctx.resolveExpressions("${{ inputs. }}"))
      .toThrow(/unsafe path segment/);
  });

  it("returns undefined for non-own input properties (e.g. toString)", () => {
    const ctx = new ExecutionContext({ x: 1 });
    expect(ctx.resolveExpressions("${{ inputs.toString }}")).toBeUndefined();
  });
});
