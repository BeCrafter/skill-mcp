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
  | ({ type: "skill:imported" } & SkillMutationCommon)
  | { type: "user:roles_changed"; userId: string }
  | { type: "role:updated"; roleId: string; affectedUserIds: string[] };

export class DomainEventBus {
  private emitter = new EventEmitter();
  private logger = getLogger();

  publish(event: DomainEvent): void {
    this.logger.debug({ event }, "Domain event published");
    // Listener isolation: a single failing subscriber must not break sibling
    // subscribers. Synchronous dispatch is preserved so tests / callers that
    // observe side effects on the next microtask still work; only the error
    // boundary changes.
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
