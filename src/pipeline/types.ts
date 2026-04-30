export interface PipelineDefinition {
  name: string;
  description?: string;
  inputs: Record<string, {
    type: string;
    required?: boolean;
    default?: unknown;
  }>;
  stages: Record<string, StageDefinition>;
  output: Record<string, string>; // Expression references
}

export interface StageDefinition {
  skill: string; // skill slug
  depends_on?: string[];
  inputs: Record<string, unknown>; // Can contain ${{ }} expressions
  outputs: string[];
  condition?: string; // Future: conditional execution
  retry?: {
    max: number;
    delay_ms: number;
  };
}

export interface StageResult {
  stage: string;
  status: "success" | "failure" | "skipped";
  outputs: Record<string, unknown>;
  duration_ms: number;
  error?: string;
}

export interface PipelineResult {
  name: string;
  status: "success" | "partial" | "failure";
  stages: StageResult[];
  output: Record<string, unknown>;
  total_duration_ms: number;
}
