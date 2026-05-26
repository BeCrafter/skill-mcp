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
  inputs: Record<string, unknown>; // Can contain ${{ }} expressions, supports embedded substitution
  outputs: string[];
  // T-203: removed `condition` and `retry` — both were schema-only with no
  // executor implementation, which made the API dishonest. Re-add when
  // there's a concrete need and corresponding executor support.
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

// Two-phase execution types

export interface PipelineStageRequest {
  stage: string;
  skill: string;
  skill_entry: string;
  resolved_inputs: Record<string, unknown>;
  depends_on: string[];
  status: "awaiting_execution" | "completed";
}

export interface PipelineAwaitingResult {
  run_id: string;
  pipeline_name: string;
  status: "awaiting_execution";
  current_batch: PipelineStageRequest[];
  completed_stages: Array<{ stage: string; outputs: Record<string, unknown> }>;
  remaining_batches: number;
}

export type PipelineResponse = PipelineAwaitingResult | PipelineResult;
