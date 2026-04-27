import type { DomainEventBus } from "./event-bus.js";
import type { ICacheProvider } from "../cache/provider.interface.js";

export function setupCacheSubscribers(bus: DomainEventBus, cache: ICacheProvider): void {
  const skillHandler = (event: { slug: string }) => {
    cache.clearByPrefix(`skill:entry:${event.slug}`);
    cache.clearByPrefix(`skill:file:${event.slug}`);
  };

  bus.on("skill:created", skillHandler);
  bus.on("skill:updated", skillHandler);
  bus.on("skill:deleted", skillHandler);
  bus.on("skill:imported", skillHandler);

  bus.on("user:roles_changed", (event) => {
    cache.delete(`skill:list:${event.userId}`);
  });

  bus.on("role:updated", (event) => {
    for (const uid of event.affectedUserIds) {
      cache.delete(`skill:list:${uid}`);
    }
  });
}
