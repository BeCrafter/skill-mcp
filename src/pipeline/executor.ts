import type { SkillService } from "../services/skill.service.js";
import type { DomainEventBus } from "../events/event-bus.js";
import type { PipelineDefinition, StageDefinition, StageResult, PipelineResult, PipelineResponse, PipelineAwaitingResult, PipelineStageRequest } from "./types.js";
import type { RequestContext } from "../types/index.js";
import { DAGScheduler } from "./dag.js";
import { ExecutionContext } from "./context.js";
import type { PipelineRunStore, PipelineRun } from "./run-store.js";
import { withSpan } from "../telemetry/spans.js";
import type { UsageMeterService } from "../services/usage-meter.service.js";

export class PipelineExecutor {
  // T-709 — per-runId mutex. resume() does check-then-act on completedStages
  // before advanceBatch; two concurrent callers each completing the last
  // missing stage in a batch would both observe allCompleted=true and both
  // advance, skipping a batch entirely. Serialize per runId.
  private resumeLocks = new Map<string, Promise<unknown>>();

  constructor(
    private skillService: SkillService,
    private runStore?: PipelineRunStore,
    private eventBus?: DomainEventBus,
    private usageMeter?: UsageMeterService,
  ) {}

  // P1-13 — emit one `pipeline.run` usage event per terminal pipeline outcome
  // (single-shot success/partial, two-phase final completion). `quantity` is
  // the count of stages actually executed so quota / billing aggregations
  // bill on real work rather than pipeline-definition size.
  private recordPipelineRun(
    pipelineName: string,
    stageCount: number,
    status: "success" | "partial",
    requestContext?: RequestContext,
  ): void {
    if (!this.usageMeter) return;
    void this.usageMeter.record({
      userId: requestContext?.userId,
      eventType: "pipeline.run",
      resourceId: pipelineName,
      quantity: Math.max(1, stageCount),
      metadata: { status },
    });
  }

  async execute(
    pipeline: PipelineDefinition,
    inputs: Record<string, unknown>,
    requestContext?: RequestContext,
  ): Promise<PipelineResult> {
    // P0-6 — `pipeline.{name}` root span (§17.6). Single-shot execute path
    // (no run store) — useful for trace tools that visualize the entire DAG
    // top to bottom.
    return withSpan(
      `pipeline.${pipeline.name}`,
      { ctx: requestContext ?? null, attributes: { "pipeline.name": pipeline.name, "pipeline.stage_count": Object.keys(pipeline.stages).length } },
      () => this._executeImpl(pipeline, inputs, requestContext),
    );
  }

  private async _executeImpl(
    pipeline: PipelineDefinition,
    inputs: Record<string, unknown>,
    requestContext?: RequestContext,
  ): Promise<PipelineResult> {
    // Validate required inputs
    for (const [key, inputDef] of Object.entries(pipeline.inputs)) {
      if (inputDef.required && !(key in inputs)) {
        if (inputDef.default !== undefined) {
          inputs[key] = inputDef.default;
        } else {
          throw new Error(`Required input "${key}" is missing`);
        }
      }
    }

    const dag = new DAGScheduler(pipeline.stages);
    const context = new ExecutionContext(inputs);
    const results: StageResult[] = [];
    const startTime = Date.now();

    let batchIndex = 0;
    for (const batch of dag.getBatches()) {
      // P0-6 — `pipeline.batch` span groups the parallel stage spans.
      const currentBatchIndex = batchIndex++;
      await withSpan(
        "pipeline.batch",
        { ctx: requestContext ?? null, attributes: { "pipeline.batch.index": currentBatchIndex, "pipeline.batch.stage_count": batch.length } },
        async () => {
          const batchResults = await Promise.allSettled(
            batch.map(stageName => this.executeStage(stageName, pipeline.stages[stageName], context, requestContext)),
          );

          for (let i = 0; i < batch.length; i++) {
            const result = batchResults[i];
            if (result.status === "fulfilled") {
              context.setStageOutputs(batch[i], result.value.outputs);
              results.push(result.value);
            } else {
              results.push({
                stage: batch[i],
                status: "failure",
                outputs: {},
                duration_ms: 0,
                error: result.reason?.message ?? "Unknown error",
              });
            }
          }
        },
      );

      // If any stage in this batch failed, stop execution
      const hasFailures = results.filter(r => r.status === "failure").length > 0;
      if (hasFailures) {
        break;
      }
    }

    const allSuccess = results.every(r => r.status === "success");
    const totalDuration = Date.now() - startTime;

    // P0-6 — `pipeline.persist` span captures the final result resolution.
    const status: "success" | "partial" = allSuccess ? "success" : "partial";
    const finalResult = await withSpan(
      "pipeline.persist",
      { ctx: requestContext ?? null, attributes: { "pipeline.name": pipeline.name, "pipeline.status": status } },
      async () => ({
        name: pipeline.name,
        status,
        stages: results,
        output: context.resolveOutputs(pipeline.output),
        total_duration_ms: totalDuration,
      }),
    );
    // P1-13 — quantity counts the stages that actually ran (success or
    // failure), matching review §9.1 example where pipeline.run carries the
    // stage count rather than 1.
    this.recordPipelineRun(pipeline.name, results.length, status, requestContext);
    this.eventBus?.publish({
      type: "pipeline:completed",
      pipelineName: pipeline.name,
      status,
      stageCount: results.length,
    });
    return finalResult;
  }

  private async executeStage(
    name: string,
    stage: StageDefinition,
    context: ExecutionContext,
    requestContext?: RequestContext,
  ): Promise<StageResult> {
    return withSpan(
      "pipeline.stage",
      { ctx: requestContext ?? null, attributes: { "pipeline.stage.id": name, "pipeline.stage.skill": stage.skill } },
      () => this._executeStageImpl(name, stage, context, requestContext),
    );
  }

  private async _executeStageImpl(
    name: string,
    stage: StageDefinition,
    context: ExecutionContext,
    requestContext?: RequestContext,
  ): Promise<StageResult> {
    const start = Date.now();

    try {
      // Resolve input expressions
      const resolvedInputs = context.resolveExpressions(stage.inputs);

      // Get skill entry content
      const skillExists = await this.skillService.skillExists(stage.skill);
      if (!skillExists) {
        throw new Error(`Skill "${stage.skill}" not found`);
      }

      const skillEntry = await this.skillService.viewSkillEntry(stage.skill, requestContext);

      // In a real execution, this would be passed to an LLM agent to execute
      // For now, we return the skill entry and resolved inputs as the output
      const outputs: Record<string, unknown> = {
        skill_entry: skillEntry,
        resolved_inputs: resolvedInputs,
        // In production, outputs would be provided by the LLM execution
      };

      return {
        stage: name,
        status: "success",
        outputs,
        duration_ms: Date.now() - start,
      };
    } catch (error) {
      return {
        stage: name,
        status: "failure",
        outputs: {},
        duration_ms: Date.now() - start,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Two-phase execution methods

  async start(
    pipeline: PipelineDefinition,
    inputs: Record<string, unknown>,
    requestContext?: RequestContext,
  ): Promise<PipelineResponse> {
    if (!this.runStore) {
      throw new Error("PipelineRunStore required for two-phase execution");
    }
    this.validateInputs(pipeline, inputs);
    const runId = await this.runStore.createRun(pipeline, inputs);
    // P0-6 — root span uses runId (review §17.6 spec: `pipeline.{runId}`).
    return withSpan(
      `pipeline.${runId}`,
      { ctx: requestContext ?? null, attributes: { "pipeline.run_id": runId, "pipeline.name": pipeline.name } },
      () => this.executeBatch(runId, requestContext),
    );
  }

  async resume(
    runId: string,
    stageOutputs: Record<string, Record<string, unknown>>,
    requestContext?: RequestContext,
  ): Promise<PipelineResponse> {
    // T-709 — chain onto the pending lock for this runId so completeStage +
    // allCompleted check + advanceBatch run atomically. Without this, two
    // concurrent resume() calls each completing the last missing stage in a
    // batch would both observe allCompleted=true and both advanceBatch,
    // silently skipping a batch.
    const prev = this.resumeLocks.get(runId) ?? Promise.resolve();
    // Run impl after prev settles regardless of outcome — prev may belong to a
    // different caller that failed; that failure is theirs to handle, not ours.
    const next = prev.then(
      () => this.resumeImpl(runId, stageOutputs, requestContext),
      () => this.resumeImpl(runId, stageOutputs, requestContext),
    );
    // Track a swallowed-rejection variant so the next chain link doesn't
    // produce an unhandled rejection if `next` rejects and no future caller
    // attaches a handler before the microtask queue flushes.
    const tracked = next.then(
      () => undefined,
      () => undefined,
    );
    this.resumeLocks.set(runId, tracked);
    void tracked.then(() => {
      if (this.resumeLocks.get(runId) === tracked) {
        this.resumeLocks.delete(runId);
      }
    });
    return await next;
  }

  private async resumeImpl(
    runId: string,
    stageOutputs: Record<string, Record<string, unknown>>,
    requestContext?: RequestContext,
  ): Promise<PipelineResponse> {
    const run = this.runStore?.getRun(runId);
    if (!run) {
      throw new Error(`Pipeline run "${runId}" not found or expired`);
    }

    // P0-6 — `pipeline.stage.persist` span (§17.6) wraps the per-stage result
    // commit on resume. We emit one span per persisted stage so traces show
    // both how many stage results arrived in this resume call and how long
    // the persist itself took.
    for (const [stageName, outputs] of Object.entries(stageOutputs)) {
      await withSpan(
        "pipeline.stage.persist",
        { ctx: requestContext ?? null, attributes: { "pipeline.run_id": runId, "pipeline.stage.id": stageName } },
        async () => {
          this.runStore?.completeStage(runId, stageName, outputs);
          run.context.setStageOutputs(stageName, outputs);
        },
      );
    }

    // Check if all stages in current batch are completed
    const currentBatch = run.batches[run.currentBatchIndex];
    const allCompleted = currentBatch.every(s => run.completedStages.has(s));

    if (!allCompleted) {
      // Return current batch (some stages still need outputs)
      return await this.buildAwaitingResult(run, requestContext);
    }

    // Advance to next batch
    const nextBatch = this.runStore?.advanceBatch(runId);
    if (!nextBatch) {
      // P0-6 — `pipeline.persist` span for the two-phase completion path.
      const finalResult = await withSpan(
        "pipeline.persist",
        { ctx: requestContext ?? null, attributes: { "pipeline.run_id": runId, "pipeline.name": run.pipeline.name, "pipeline.status": "success" } },
        async () => {
          const output = run.context.resolveExpressions(run.pipeline.output ?? {});
          return {
            name: run.pipeline.name,
            status: "success" as const,
            stages: this.buildStageResults(run),
            output: output as Record<string, unknown>,
            total_duration_ms: Date.now() - run.createdAt,
          };
        },
      );
      // P1-13 — meter the two-phase pipeline at terminal completion. Use the
      // count of successfully completed stages rather than the pipeline's
      // declared stage count: a partial run that finishes via early exit
      // should bill for what actually ran.
      this.recordPipelineRun(run.pipeline.name, run.completedStages.size, "success", requestContext);
      this.eventBus?.publish({
        type: "pipeline:completed",
        runId,
        pipelineName: run.pipeline.name,
        status: "success",
        stageCount: run.completedStages.size,
      });
      return finalResult;
    }

    return this.executeBatch(runId, requestContext);
  }

  private async executeBatch(runId: string, requestContext?: RequestContext): Promise<PipelineResponse> {
    const run = this.runStore?.getRun(runId);
    if (!run) throw new Error(`Pipeline run "${runId}" not found`);

    const batch = run.batches[run.currentBatchIndex];
    return withSpan(
      "pipeline.batch",
      { ctx: requestContext ?? null, attributes: { "pipeline.run_id": runId, "pipeline.batch.index": run.currentBatchIndex, "pipeline.batch.stage_count": batch.length } },
      () => this._executeBatchImpl(runId, run, batch, requestContext),
    );
  }

  private async _executeBatchImpl(
    runId: string,
    run: PipelineRun,
    batch: string[],
    requestContext?: RequestContext,
  ): Promise<PipelineResponse> {
    // T-703 — stages within a single batch are dependency-free by construction
    // (DAGScheduler guarantee), so resolve their skill entries in parallel
    // instead of awaiting one at a time. Latency now scales with the slowest
    // stage in the batch, not the sum.
    const stageRequests = await this.buildStageRequests(batch, run, requestContext);

    return {
      run_id: runId,
      pipeline_name: run.pipeline.name,
      status: "awaiting_execution" as const,
      current_batch: stageRequests,
      completed_stages: Array.from(run.completedStages.entries()).map(([stage, outputs]) => ({
        stage,
        outputs,
      })),
      remaining_batches: run.batches.length - run.currentBatchIndex - 1,
    };
  }

  private async buildAwaitingResult(run: PipelineRun, requestContext?: RequestContext): Promise<PipelineAwaitingResult> {
    const batch = run.batches[run.currentBatchIndex];
    const stageRequests = await this.buildStageRequests(batch, run, requestContext);

    return {
      run_id: run.runId,
      pipeline_name: run.pipeline.name,
      status: "awaiting_execution",
      current_batch: stageRequests,
      completed_stages: Array.from(run.completedStages.entries()).map(([stage, outputs]) => ({
        stage,
        outputs,
      })),
      remaining_batches: run.batches.length - run.currentBatchIndex - 1,
    };
  }

  // T-703 — shared helper used by both `executeBatch` and `buildAwaitingResult`.
  // Resolves each stage's skill entry concurrently so a wide batch's latency is
  // bounded by the slowest stage rather than their sum.
  private async buildStageRequests(
    batch: string[],
    run: PipelineRun,
    requestContext?: RequestContext,
  ): Promise<PipelineStageRequest[]> {
    const stageNames = batch.filter((name) => run.pipeline.stages[name]);
    return await Promise.all(
      stageNames.map(async (stageName) => {
        const stage = run.pipeline.stages[stageName];
        const resolved_inputs = run.context.resolveExpressions(stage.inputs) as Record<string, unknown>;
        const skillEntry = await this.skillService.viewSkillEntry(stage.skill, requestContext);
        return {
          stage: stageName,
          skill: stage.skill,
          skill_entry: skillEntry,
          resolved_inputs,
          depends_on: stage.depends_on ?? [],
          status: "awaiting_execution" as const,
        };
      }),
    );
  }

  private buildStageResults(run: PipelineRun): StageResult[] {
    // Build StageResult array from completed stages for final result
    // Since we don't track duration per stage in the two-phase model,
    // we estimate it as a fraction of total time
    const totalStages = Object.keys(run.pipeline.stages).length;
    const avgDuration = (Date.now() - run.createdAt) / totalStages;

    return Array.from(run.completedStages.entries()).map(([stage, outputs]) => ({
      stage,
      status: "success" as const,
      outputs,
      duration_ms: Math.round(avgDuration),
    }));
  }

  private validateInputs(pipeline: PipelineDefinition, inputs: Record<string, unknown>): void {
    for (const [key, inputDef] of Object.entries(pipeline.inputs)) {
      if (inputDef.required && !(key in inputs)) {
        if (inputDef.default !== undefined) {
          inputs[key] = inputDef.default;
        } else {
          throw new Error(`Required input "${key}" is missing`);
        }
      }
    }
  }
}
