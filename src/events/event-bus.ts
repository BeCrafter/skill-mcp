import { EventEmitter } from "node:events";
import { getLogger } from "../utils/logger.js";
import { metrics } from "../telemetry/metrics.js";
import type { SkillVisibility } from "../types/index.js";

/**
 * Skill mutation events carry `visibility` / `tags` so cache subscribers
 * can compute the affected user set without re-querying the DB. Optional
 * for back-compat: when omitted, subscribers must fall back to the safe
 * (pessimistic) global invalidation.
 */
interface SkillMutationCommon {
  slug: string;
  visibility?: SkillVisibility;
  tags?: string[];
}

export type DomainEvent =
  | ({ type: "skill:created" } & SkillMutationCommon)
  | ({ type: "skill:updated" } & SkillMutationCommon)
  | ({ type: "skill:deleted" } & SkillMutationCommon)
  | ({ type: "skill:imported" } & SkillMutationCommon & { version?: string; action?: "created" | "updated"; name?: string })
  | ({ type: "skill:deprecated" } & SkillMutationCommon & { version?: string })
  | { type: "pipeline:completed"; runId?: string; pipelineName: string; status: "success" | "partial" | "failed"; stageCount: number }
  | { type: "user:token_rotated"; userId: string; rotatedAt: number; previousTokenExpiresAt?: number | null }
  | { type: "user:roles_changed"; userId: string }
  | { type: "user:logged_in"; userId: string; username: string }
  | { type: "user:password_changed"; userId: string }
  | { type: "role:updated"; roleId: string; affectedUserIds: string[] };

export interface DomainEventBusOptions {
  /**
   * When true, listeners are dispatched on a deferred task (`setImmediate`)
   * so the publisher's call stack returns immediately. The HTTP write path
   * (admin POST/PUT/DELETE) no longer waits for cache invalidation —
   * `clearByPrefix` against L2 (file cache) can take 5-50ms in pathological
   * cases (P0-B fix for §3.2 in commercialization review).
   *
   * Default false: legacy synchronous dispatch with try/catch isolation.
   * Tests that assert "right after publish, the cache is cleared" rely on
   * sync dispatch and continue to use the default.
   */
  async?: boolean;
}

export class DomainEventBus {
  private emitter = new EventEmitter();
  private logger = getLogger();
  private readonly asyncDispatch: boolean;

  constructor(opts: DomainEventBusOptions = {}) {
    this.asyncDispatch = opts.async ?? false;
  }

  publish(event: DomainEvent): void {
    this.logger.debug({ event }, "Domain event published");
    if (this.asyncDispatch) {
      // Defer to next tick so the publisher's response cycle is not
      // blocked on listener I/O. Listener errors still go through the
      // same isolation path; only the call timing changes.
      setImmediate(() => this.dispatch(event));
      return;
    }
    this.dispatch(event);
  }

  private dispatch(event: DomainEvent): void {
    // Listener isolation: a single failing subscriber must not break sibling
    // subscribers.
    const listeners = this.emitter.listeners(event.type) as Array<(e: DomainEvent) => unknown>;
    for (const listener of listeners) {
      const end = metrics.eventListenerDuration.startTimer({ event: event.type });
      try {
        const result = listener(event);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>).then(
            () => end({ status: "ok" }),
            (err) => {
              end({ status: "error" });
              metrics.eventListenerErrors.inc({ event: event.type });
              this.logger.warn({ err, eventType: event.type }, "Async event handler rejected");
            },
          );
        } else {
          end({ status: "ok" });
        }
      } catch (err) {
        end({ status: "error" });
        metrics.eventListenerErrors.inc({ event: event.type });
        this.logger.warn({ err, eventType: event.type }, "Event handler threw");
      }
    }
  }

  on<T extends DomainEvent["type"]>(
    type: T,
    handler: (event: Extract<DomainEvent, { type: T }>) => void,
  ): void {
    this.emitter.on(type, handler);
  }
}
