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
 */
export class CacheEpochManager {
  private userEpochs = new Map<string, number>();
  private globalEpoch = 0;

  /** Returns the user's epoch (0 if never bumped). */
  getUserEpoch(userId: string): number {
    return this.userEpochs.get(userId) ?? 0;
  }

  getGlobalEpoch(): number {
    return this.globalEpoch;
  }

  bumpUser(userId: string): void {
    this.userEpochs.set(userId, this.getUserEpoch(userId) + 1);
  }

  bumpUsers(userIds: Iterable<string>): void {
    for (const u of userIds) this.bumpUser(u);
  }

  /** Bump the global epoch — invalidates every user's list cache. */
  bumpGlobal(): void {
    this.globalEpoch++;
  }

  /** Compose the per-user version suffix used by SkillService cache keys. */
  versionSuffix(userId: string): string {
    return `g${this.globalEpoch}:u${this.getUserEpoch(userId)}`;
  }
}
