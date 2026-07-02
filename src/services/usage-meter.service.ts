import type { Logger } from "pino";
import type {
  UsageEventRepository,
  UsageEventCreate,
  AggregateOptions,
  AggregateRow,
  ListOptions,
  UsageEventEntity,
} from "../db/repositories/usage-event.repository.js";
import { metrics } from "../telemetry/metrics.js";

// P1-13 — Usage metering service (review §9.1).
//
// Fire-and-forget write semantics: `record()` schedules a `setImmediate`
// callback that catches every error and converts it into a logger.warn +
// metrics counter — production hot paths (skill.view, pipeline.run,
// api.call, storage.write) MUST NOT block on metering DB writes nor
// crash if the row insert fails.
//
// Aggregation is read-through to the repository so callers (admin REST)
// get a fresh view; an in-memory cache would only mask billing-grade
// misses for negligible savings — the covering index keeps queries cheap.
export class UsageMeterService {
  constructor(
    private readonly repo: UsageEventRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Fire-and-forget metering record. Returns a resolved Promise that the
   * caller MAY await for sequencing, but the typical hot-path call is
   * `void usageMeter.record(...)`. The returned promise NEVER rejects:
   * a DB failure is swallowed, logged, and counted in
   * `skill_mcp_usage_events_total{status="error"}`.
   */
  record(input: UsageEventCreate): Promise<void> {
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        this._recordImpl(input);
        resolve();
      });
    });
  }

  /**
   * Synchronous variant for callers that already run on a background
   * boundary (e.g. inside a finally block of an async operation that's
   * already off the request thread). Same swallow-and-log semantics.
   */
  recordSync(input: UsageEventCreate): void {
    this._recordImpl(input);
  }

  private _recordImpl(input: UsageEventCreate): void {
    try {
      this.repo.create(input);
      metrics.usageEventsRecorded.inc({ event_type: input.eventType, status: "ok" });
    } catch (err) {
      metrics.usageEventsRecorded.inc({ event_type: input.eventType, status: "error" });
      this.logger.warn(
        { err, eventType: input.eventType, resourceId: input.resourceId },
        "Failed to record usage event (fire-and-forget; request continues)",
      );
    }
  }

  /** Pass-through to the repository aggregate query. */
  aggregate(opts: AggregateOptions): AggregateRow[] {
    return this.repo.aggregate(opts);
  }

  /** Pass-through to the repository sumQuantity query — returns 0 on any error. */
  sumQuantity(opts: AggregateOptions): number {
    try {
      return this.repo.sumQuantity(opts);
    } catch (err) {
      this.logger.warn({ err, opts }, "Failed to read usage sum; returning 0");
      return 0;
    }
  }

  /** List raw events (admin endpoint / CSV export). */
  list(opts: ListOptions): UsageEventEntity[] {
    return this.repo.list(opts);
  }

  /** Delete events older than `cutoffMs`. Used by retention CLI. */
  deleteOlderThan(cutoffMs: number): number {
    return this.repo.deleteOlderThan(cutoffMs);
  }
}
