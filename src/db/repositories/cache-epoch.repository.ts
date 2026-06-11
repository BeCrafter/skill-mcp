import { eq } from "drizzle-orm";
import type { DrizzleDB } from "../connection.js";
import { cacheGlobalEpoch, cacheUserEpochs } from "../schema.js";

/**
 * Persistence for `CacheEpochManager` (P0-B).
 *
 * The repository is intentionally simple: write-through on every bump.
 * Throughput is bounded by event publish frequency (orders of magnitude
 * lower than skill reads), so a per-bump UPSERT is cheaper than batching.
 *
 * Failure mode: if the DB write fails, the in-memory bump still happens
 * (the manager logs and continues). On the *next* successful bump for the
 * same key, the DB catches up to the in-memory value. The only window
 * where stale data can be served is when (a) the DB write failed, AND
 * (b) the process crashed before another bump succeeded — which is the
 * same window as a missed event in any best-effort cache invalidation
 * scheme. We accept it.
 */
export class CacheEpochRepository {
  constructor(private db: DrizzleDB) {}

  loadGlobal(): number {
    const row = this.db.select().from(cacheGlobalEpoch).where(eq(cacheGlobalEpoch.id, "global")).get();
    return row?.epoch ?? 0;
  }

  loadAllUsers(): Map<string, number> {
    const rows = this.db.select().from(cacheUserEpochs).all();
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.userId, r.epoch);
    return map;
  }

  saveGlobal(epoch: number): void {
    const now = Date.now();
    this.db
      .insert(cacheGlobalEpoch)
      .values({ id: "global", epoch, updatedAt: now })
      .onConflictDoUpdate({
        target: cacheGlobalEpoch.id,
        set: { epoch, updatedAt: now },
      })
      .run();
  }

  saveUser(userId: string, epoch: number): void {
    const now = Date.now();
    this.db
      .insert(cacheUserEpochs)
      .values({ userId, epoch, updatedAt: now })
      .onConflictDoUpdate({
        target: cacheUserEpochs.userId,
        set: { epoch, updatedAt: now },
      })
      .run();
  }

  saveUsers(updates: Iterable<[string, number]>): void {
    const now = Date.now();
    for (const [userId, epoch] of updates) {
      this.db
        .insert(cacheUserEpochs)
        .values({ userId, epoch, updatedAt: now })
        .onConflictDoUpdate({
          target: cacheUserEpochs.userId,
          set: { epoch, updatedAt: now },
        })
        .run();
    }
  }
}
