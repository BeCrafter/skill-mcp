import { eq, asc } from "drizzle-orm";
import { generateId, generateUniqueId } from "../../utils/id.js";
import type { DrizzleDB } from "../connection.js";
import { importJobs } from "../schema.js";
import type { ImportOptions, ImportResult } from "../../types/index.js";

// P0-10 — async import jobs. The four canonical statuses:
//   queued    — created, awaiting worker pickup
//   running   — worker has the job, owns progress updates
//   succeeded — final state, `result` is the ImportResult
//   failed    — final state, `errorMessage` carries the cause
export type ImportJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface ImportJobEntity {
  id: string;
  status: ImportJobStatus;
  source: string;
  options: ImportOptions;
  progress: number;
  message: string | null;
  result: ImportResult | null;
  errorMessage: string | null;
  createdByUserId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ImportJobCreate {
  source: string;
  options: ImportOptions;
  createdByUserId?: string | null;
}

export class ImportJobRepository {
  constructor(private db: DrizzleDB) {}

  async create(input: ImportJobCreate): Promise<ImportJobEntity> {
    const id = await generateUniqueId(() => generateId("job_"), async (id) => !!(await this.findById(id)));
    const now = Date.now();
    this.db.insert(importJobs).values({
      id,
      status: "queued",
      source: input.source,
      optionsJson: JSON.stringify(input.options ?? {}),
      progress: 0,
      message: null,
      resultJson: null,
      errorMessage: null,
      createdByUserId: input.createdByUserId ?? null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    }).run();
    return this.findById(id) as ImportJobEntity;
  }

  findById(id: string): ImportJobEntity | null {
    const row = this.db.select().from(importJobs).where(eq(importJobs.id, id)).limit(1).all()[0];
    return row ? this.toEntity(row) : null;
  }

  /**
   * Atomically claim the next queued job. Returns null when the queue is
   * empty. The pattern is "select then update id+status" which is safe in
   * SQLite because better-sqlite3 serializes writes; a future PG dialect
   * (P0-8) should switch to `SELECT ... FOR UPDATE SKIP LOCKED`.
   */
  claimNext(now: number = Date.now()): ImportJobEntity | null {
    const row = this.db
      .select()
      .from(importJobs)
      .where(eq(importJobs.status, "queued"))
      .orderBy(asc(importJobs.createdAt))
      .limit(1)
      .all()[0];
    if (!row) return null;
    const result = this.db.update(importJobs)
      .set({ status: "running", startedAt: now })
      .where(eq(importJobs.id, row.id))
      .run();
    if (result.changes === 0) return null;
    return this.findById(row.id);
  }

  updateProgress(id: string, progress: number, message?: string | null): void {
    const clamped = Math.min(100, Math.max(0, Math.floor(progress)));
    this.db.update(importJobs)
      .set({ progress: clamped, message: message ?? null })
      .where(eq(importJobs.id, id))
      .run();
  }

  markSucceeded(id: string, result: ImportResult): void {
    this.db.update(importJobs).set({
      status: "succeeded",
      progress: 100,
      message: "Import completed",
      resultJson: JSON.stringify(result),
      finishedAt: Date.now(),
    }).where(eq(importJobs.id, id)).run();
  }

  markFailed(id: string, errorMessage: string): void {
    this.db.update(importJobs).set({
      status: "failed",
      message: "Import failed",
      errorMessage,
      finishedAt: Date.now(),
    }).where(eq(importJobs.id, id)).run();
  }

  /**
   * Boot recovery — any row left in `running` after a process crash is
   * resurrected back to `queued` so the worker picks it up. We do not retry
   * inside the same job because the importer's staging-commit may have
   * left half-applied state; a fresh run from source is the safer reset.
   */
  recoverOrphans(): number {
    const result = this.db.update(importJobs)
      .set({ status: "queued", startedAt: null })
      .where(eq(importJobs.status, "running"))
      .run();
    return result.changes ?? 0;
  }

  list(opts: { status?: ImportJobStatus; limit?: number } = {}): ImportJobEntity[] {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
    const baseQuery = this.db.select().from(importJobs);
    const filtered = opts.status
      ? baseQuery.where(eq(importJobs.status, opts.status))
      : baseQuery;
    const rows = filtered.orderBy(asc(importJobs.createdAt)).limit(limit).all();
    return rows.map(r => this.toEntity(r));
  }

  private toEntity(row: typeof importJobs.$inferSelect): ImportJobEntity {
    let options: ImportOptions = {};
    try { options = JSON.parse(row.optionsJson) as ImportOptions; } catch { /* keep default */ }
    let result: ImportResult | null = null;
    if (row.resultJson) {
      try { result = JSON.parse(row.resultJson) as ImportResult; } catch { result = null; }
    }
    return {
      id: row.id,
      status: row.status,
      source: row.source,
      options,
      progress: row.progress,
      message: row.message ?? null,
      result,
      errorMessage: row.errorMessage ?? null,
      createdByUserId: row.createdByUserId ?? null,
      createdAt: row.createdAt,
      startedAt: row.startedAt ?? null,
      finishedAt: row.finishedAt ?? null,
    };
  }
}
