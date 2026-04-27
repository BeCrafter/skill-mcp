import type { StageDefinition } from "./types.js";

export class DAGScheduler {
  private adjacency: Map<string, string[]>;
  private inDegree: Map<string, number>;
  private stages: Record<string, StageDefinition>;

  constructor(stages: Record<string, StageDefinition>) {
    this.stages = stages;
    this.adjacency = new Map();
    this.inDegree = new Map();

    // Build adjacency list and in-degree map
    for (const stageName of Object.keys(stages)) {
      this.adjacency.set(stageName, []);
      this.inDegree.set(stageName, 0);
    }

    for (const [stageName, stage] of Object.entries(stages)) {
      if (stage.depends_on) {
        for (const dep of stage.depends_on) {
          if (!this.adjacency.has(dep)) {
            throw new Error(`Stage "${stageName}" depends on unknown stage "${dep}"`);
          }
          this.adjacency.get(dep)!.push(stageName);
          this.inDegree.set(stageName, this.inDegree.get(stageName)! + 1);
        }
      }
    }

    // Check for cycles
    this.detectCycles();
  }

  /**
   * Returns batches of stages that can be executed in parallel.
   * Each batch contains stages with no unmet dependencies.
   */
  getBatches(): string[][] {
    const batches: string[][] = [];
    const inDegree = new Map(this.inDegree);
    const completed = new Set<string>();

    while (completed.size < Object.keys(this.stages).length) {
      // Find all stages with in-degree 0 (no unmet dependencies)
      const batch = [];
      for (const [stage, degree] of inDegree.entries()) {
        if (degree === 0 && !completed.has(stage)) {
          batch.push(stage);
        }
      }

      if (batch.length === 0) {
        throw new Error("Circular dependency detected in pipeline");
      }

      batches.push(batch);

      // Mark batch as completed and decrement in-degrees
      for (const stage of batch) {
        completed.add(stage);
        inDegree.delete(stage);
        for (const dependent of this.adjacency.get(stage)!) {
          inDegree.set(dependent, inDegree.get(dependent)! - 1);
        }
      }
    }

    return batches;
  }

  private detectCycles(): void {
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (node: string): boolean => {
      visited.add(node);
      recStack.add(node);

      for (const neighbor of this.adjacency.get(node)!) {
        if (!visited.has(neighbor)) {
          if (dfs(neighbor)) return true;
        } else if (recStack.has(neighbor)) {
          throw new Error(`Circular dependency detected: ${node} -> ${neighbor}`);
        }
      }

      recStack.delete(node);
      return false;
    };

    for (const node of Object.keys(this.stages)) {
      if (!visited.has(node)) {
        dfs(node);
      }
    }
  }
}
