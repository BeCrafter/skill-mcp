import { EventEmitter } from "node:events";
import { getLogger } from "../utils/logger.js";

export type DomainEvent =
  | { type: "skill:created"; slug: string }
  | { type: "skill:updated"; slug: string }
  | { type: "skill:deleted"; slug: string }
  | { type: "skill:imported"; slug: string }
  | { type: "user:roles_changed"; userId: string }
  | { type: "role:updated"; roleId: string; affectedUserIds: string[] };

export class DomainEventBus {
  private emitter = new EventEmitter();
  private logger = getLogger();

  publish(event: DomainEvent): void {
    this.logger.debug({ event }, "Domain event published");
    this.emitter.emit(event.type, event);
  }

  on<T extends DomainEvent["type"]>(
    type: T,
    handler: (event: Extract<DomainEvent, { type: T }>) => void,
  ): void {
    this.emitter.on(type, handler);
  }
}
