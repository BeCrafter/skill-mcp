export class ExecutionContext {
  private inputs: Record<string, unknown>;
  private stageOutputs: Map<string, Record<string, unknown>>;

  constructor(inputs: Record<string, unknown>) {
    this.inputs = inputs;
    this.stageOutputs = new Map();
  }

  getInput(key: string): unknown {
    return this.inputs[key];
  }

  setStageOutputs(stageName: string, outputs: Record<string, unknown>): void {
    this.stageOutputs.set(stageName, outputs);
  }

  getStageOutputs(stageName: string): Record<string, unknown> | undefined {
    return this.stageOutputs.get(stageName);
  }

  getStageOutput(stageName: string, outputKey: string): unknown {
    return this.stageOutputs.get(stageName)?.[outputKey];
  }

  /**
   * Resolve expressions in an object recursively.
   * Supports ${{ inputs.xxx }}, ${{ stages.xxx.outputs.yyy }}, ${{ stages.xxx.outputs }}
   */
  resolveExpressions(obj: unknown): unknown {
    if (typeof obj === "string") {
      return this.resolveExpression(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.resolveExpressions(item));
    }

    if (obj && typeof obj === "object") {
      const resolved: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        resolved[key] = this.resolveExpressions(value);
      }
      return resolved;
    }

    return obj;
  }

  /**
   * Resolve a single expression string.
   *
   * Two modes (T-203):
   * - Whole-string match `^${{ expr }}$` → returns the resolved value with
   *   its native type preserved (objects, arrays, numbers).
   * - Embedded `${{ expr }}` inside a larger string → each occurrence is
   *   stringified and spliced in (e.g. `"https://x/${{ inputs.id }}/y"`).
   */
  private resolveExpression(expr: string): unknown {
    const wholeMatch = expr.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
    if (wholeMatch) {
      return this.resolvePath(wholeMatch[1], expr);
    }

    if (!expr.includes("${{")) return expr;

    return expr.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_match, path: string) => {
      const value = this.resolvePath(path.trim(), expr);
      if (value === null || value === undefined) return "";
      return typeof value === "string" ? value : JSON.stringify(value);
    });
  }

  private resolvePath(pathStr: string, originalExpr: string): unknown {
    const path = pathStr.split(".");

    // T-502: reject empty segments and prototype-walking keys before they
    // reach any object property access. `inputs.__proto__`, `stages.x.outputs.constructor`,
    // and `inputs.` (empty) would otherwise leak prototype refs into resolved outputs.
    for (const seg of path) {
      if (!isSafePathSegment(seg)) {
        throw new Error(`Invalid expression: ${originalExpr} (unsafe path segment: ${seg || "<empty>"})`);
      }
    }

    if (path[0] === "inputs") {
      if (path.length !== 2) {
        throw new Error(`Invalid expression: ${originalExpr} (expected inputs.key)`);
      }
      return Object.prototype.hasOwnProperty.call(this.inputs, path[1])
        ? this.inputs[path[1]]
        : undefined;
    }

    if (path[0] === "stages") {
      if (path.length < 3) {
        throw new Error(`Invalid expression: ${originalExpr} (expected stages.name.outputs[.key])`);
      }
      const stageName = path[1];
      if (path[2] !== "outputs") {
        throw new Error(`Invalid expression: ${originalExpr} (expected stages.name.outputs[.key])`);
      }

      const outputs = this.stageOutputs.get(stageName);
      if (path.length === 3) {
        return outputs;
      }

      const outputKey = path[3];
      if (!outputs) return undefined;
      return Object.prototype.hasOwnProperty.call(outputs, outputKey) ? outputs[outputKey] : undefined;
    }

    throw new Error(`Invalid expression: ${originalExpr} (unknown prefix: ${path[0]})`);
  }

  /**
   * Resolve output expressions using stage outputs.
   */
  resolveOutputs(outputDef: Record<string, string>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, expr] of Object.entries(outputDef)) {
      resolved[key] = this.resolveExpression(expr);
    }
    return resolved;
  }
}

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isSafePathSegment(seg: string): boolean {
  if (!seg) return false;
  if (FORBIDDEN_PATH_SEGMENTS.has(seg)) return false;
  return true;
}
