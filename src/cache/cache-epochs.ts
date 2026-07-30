import type { CacheEpochRepository } from "../db/repositories/cache-epoch.repository.js";
import { getLogger } from "../utils/logger.js";

/**
 * Per-user cache invalidation via monotonic version counters (epochs).
 *
 * Why not `clearByPrefix("skill:list:")`? It scans every cache entry and
 * clobbers buckets for users who could not have been affected by the
 * change. With epoch counters, invalidation is O(1) — we bump a number,
 * stale keys remain in cache until their TTL expires (and are simply
 * never read again because the cache lookup builds a key with the new
 * epoch). LRU pressure / TTL handle the eventual eviction.
 *
 * The cache key format used by `SkillService.getAccessibleSkillsForUser`:
 *   `skill:list:{userId}:g{globalEpoch}:u{userEpoch}`
 *
 * - `globalEpoch` bumps on changes that affect every authenticated user
 *   (public/internal skill mutations, or private skills with empty tag
 *   list — visible to all). One bump fans out to every user.
 * - `userEpoch` bumps on changes specific to a user (their roles changed,
 *   or a private+tagged skill they can see was mutated). Other users'
 *   caches stay valid.
 *
 * **Persistence (P0-B)**: an optional `CacheEpochRepository` makes the
 * counters survive process restarts. Without it, after a restart the
 * counter resets to 0; if the L2 (file) cache from the previous run had
 * a key like `skill:list:U:g3:u2`, a new request that looks up
 * `skill:list:U:g0:u0` will *miss* (different key) and re-read from the
 * source — safe. The risk is the *opposite*: if the previous run stopped
 * at `g0:u0`, then a fresh process starting at `g0:u0` could in principle
 * collide with a stale L2 entry. Persisting the counter and reloading it
 * (via `hydrate()`) avoids that collision. Bumps are write-through.
 */
export class CacheEpochManager {
  private userEpochs = new Map<string, number>();
  private globalEpoch = 0;
  private readonly repo?: CacheEpochRepository;
  private readonly logger = getLogger();

  constructor(repo?: CacheEpochRepository) {
    this.repo = repo;
  }

  /**
   * Load persisted counters from the repository (if configured). Call this
   * once at startup, before any cache reads, so the in-memory counter
   * matches what was last persisted.
   */
  hydrate(): void {
    if (!this.repo) return;
    try {
      this.globalEpoch = this.repo.loadGlobal();
      this.userEpochs = this.repo.loadAllUsers();
    } catch (err) {
      this.logger.warn({ err }, "CacheEpochManager.hydrate failed; continuing with in-memory zeros");
    }
  }

  /** Returns the user's epoch (0 if never bumped). */
  getUserEpoch(userId: string): number {
    return this.userEpochs.get(userId) ?? 0;
  }

  getGlobalEpoch(): number {
    return this.globalEpoch;
  }

  bumpUser(userId: string): void {
    const next = this.getUserEpoch(userId) + 1;
    this.userEpochs.set(userId, next);
    this.persistUser(userId, next);
  }

  bumpUsers(userIds: Iterable<string>): void {
    if (!this.repo) {
      for (const u of userIds) this.bumpUser(u);
      return;
    }
    const updates: Array<[string, number]> = [];
    for (const u of userIds) {
      const next = this.getUserEpoch(u) + 1;
      this.userEpochs.set(u, next);
      updates.push([u, next]);
    }
    try {
      this.repo.saveUsers(updates);
    } catch (err) {
      this.logger.warn({ err, count: updates.length }, "CacheEpochManager.saveUsers failed");
    }
  }

  /** Bump the global epoch — invalidates every user's list cache. */
  bumpGlobal(): void {
    this.globalEpoch++;
    if (!this.repo) return;
    try {
      this.repo.saveGlobal(this.globalEpoch);
    } catch (err) {
      this.logger.warn({ err, epoch: this.globalEpoch }, "CacheEpochManager.saveGlobal failed");
    }
  }

  /** Compose the per-user version suffix used by SkillService cache keys. */
  versionSuffix(userId: string): string {
    return `g${this.globalEpoch}:u${this.getUserEpoch(userId)}`;
  }

  private persistUser(userId: string, epoch: number): void {
    if (!this.repo) return;
    try {
      this.repo.saveUser(userId, epoch);
    } catch (err) {
      this.logger.warn({ err, userId, epoch }, "CacheEpochManager.saveUser failed");
    }
  }
}
