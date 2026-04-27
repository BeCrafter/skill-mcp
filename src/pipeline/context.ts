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
   */
  private resolveExpression(expr: string): unknown {
    const match = expr.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
    if (!match) return expr; // Not an expression

    const path = match[1].split(".");

    if (path[0] === "inputs") {
      if (path.length !== 2) {
        throw new Error(`Invalid expression: ${expr} (expected inputs.key)`);
      }
      return this.inputs[path[1]];
    }

    if (path[0] === "stages") {
      if (path.length < 3) {
        throw new Error(`Invalid expression: ${expr} (expected stages.name.outputs[.key])`);
      }
      const stageName = path[1];
      if (path[2] !== "outputs") {
        throw new Error(`Invalid expression: ${expr} (expected stages.name.outputs[.key])`);
      }

      if (path.length === 3) {
        // ${{ stages.xxx.outputs }}
        return this.stageOutputs.get(stageName);
      }

      // ${{ stages.xxx.outputs.yyy }}
      const outputKey = path[3];
      return this.stageOutputs.get(stageName)?.[outputKey];
    }

    throw new Error(`Invalid expression: ${expr} (unknown prefix: ${path[0]})`);
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
