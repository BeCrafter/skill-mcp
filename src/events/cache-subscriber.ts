import type { DomainEventBus } from "./event-bus.js";
import type { ICacheProvider } from "../cache/provider.interface.js";
import type { CacheEpochManager } from "../cache/cache-epochs.js";
import type { RoleRepository } from "../db/repositories/role.repository.js";
import type { UserRoleRepository } from "../db/repositories/user-role.repository.js";
import type { SkillVisibility } from "../types/index.js";
import { getLogger } from "../utils/logger.js";

export interface CacheSubscriberDeps {
  roleRepo?: RoleRepository;
  userRoleRepo?: UserRoleRepository;
}

/**
 * Wire domain events to cache invalidation.
 *
 * - skill entry/file caches are blown away by prefix on any mutation
 *   (cheap; only one slug's worth of keys).
 * - skill list caches are invalidated via epoch bumps (see
 *   CacheEpochManager) so we don't fan-out to users who could not have
 *   been affected by the change.
 */
export function setupCacheSubscribers(
  bus: DomainEventBus,
  cache: ICacheProvider,
  epochs: CacheEpochManager,
  deps: CacheSubscriberDeps = {},
): void {
  const logger = getLogger();

  const skillHandler = async (event: { slug: string; visibility?: SkillVisibility; tags?: string[] }) => {
    // T-720 — `clearByPrefix` is async; an unawaited rejection (e.g. file
    // cache I/O failure) escapes this handler as unhandledRejection.
    // `.catch` converts to a warn log so the epoch bump below still runs
    // and the cache miss naturally heals via TTL.
    cache.clearByPrefix(`skill:entry:${event.slug}`).catch(
      (err) => logger.warn({ err, slug: event.slug }, "Failed to clear skill:entry cache prefix"),
    );
    cache.clearByPrefix(`skill:file:${event.slug}`).catch(
      (err) => logger.warn({ err, slug: event.slug }, "Failed to clear skill:file cache prefix"),
    );

    const visibility = event.visibility;
    const tags = event.tags ?? [];

    // Pessimistic fallback: if the publisher didn't tell us the skill's
    // visibility/tags, or if we can't resolve role membership, bump global
    // so every user sees fresh data. Stale-cache > inconsistent-cache.
    if (!visibility || !deps.roleRepo || !deps.userRoleRepo) {
      epochs.bumpGlobal();
      return;
    }

    // public/internal: visible to all authenticated users → global bump.
    // private + empty tags: visible to all authenticated users → global bump.
    // private + non-empty tags: only users with intersecting tags are affected.
    if (visibility !== "private" || tags.length === 0) {
      epochs.bumpGlobal();
      return;
    }

    try {
      const allRoles = await deps.roleRepo.findAll();
      const matchingRoleIds = allRoles
        .filter((r) => r.tags.some((t) => tags.includes(t)))
        .map((r) => r.id);
      if (matchingRoleIds.length === 0) return; // nobody can see it; nothing to invalidate

      // T-503: single batched query instead of N round-trips per matching role.
      const affected = await deps.userRoleRepo.findUserIdsByRoleIds(matchingRoleIds);
      if (affected.length === 0) return;
      epochs.bumpUsers(new Set(affected));
    } catch (err) {
      logger.warn({ err, slug: event.slug }, "Cache subscriber failed to compute affected users; falling back to global bump");
      epochs.bumpGlobal();
    }
  };

  bus.on("skill:created", skillHandler);
  bus.on("skill:updated", skillHandler);
  bus.on("skill:deleted", skillHandler);
  bus.on("skill:imported", skillHandler);

  bus.on("user:roles_changed", (event) => {
    epochs.bumpUser(event.userId);
  });

  bus.on("role:updated", (event) => {
    epochs.bumpUsers(event.affectedUserIds);
  });
}
