import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema.js";
import { ImportJobRepository } from "@/db/repositories/import-job.repository.js";

type DrizzleDB = BetterSQLite3Database<typeof schema>;

function setup(): { db: DrizzleDB; repo: ImportJobRepository } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  db.run(`CREATE TABLE import_jobs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    status TEXT NOT NULL DEFAULT 'queued',
    source TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '{}',
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    result_json TEXT,
    error_message TEXT,
    created_by_user_id TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  )`);
  return { db, repo: new ImportJobRepository(db) };
}

describe("ImportJobRepository (P0-10)", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("create stores source + options + defaults to queued", () => {
    const job = ctx.repo.create({
      source: "/tmp/skill",
      options: { tags: ["x"], versionBump: "minor" },
      createdByUserId: "u1",
    });
    expect(job.status).toBe("queued");
    expect(job.source).toBe("/tmp/skill");
    expect(job.options.tags).toEqual(["x"]);
    expect(job.progress).toBe(0);
    expect(job.createdByUserId).toBe("u1");
    expect(typeof job.createdAt).toBe("number");
    expect(job.startedAt).toBeNull();
    expect(job.finishedAt).toBeNull();
  });

  it("findById returns null for unknown id", () => {
    expect(ctx.repo.findById("nope")).toBeNull();
  });

  it("claimNext picks the oldest queued job and flips status to running", async () => {
    const a = ctx.repo.create({ source: "/a", options: {} });
    await new Promise(r => setTimeout(r, 5));
    const b = ctx.repo.create({ source: "/b", options: {} });
    const claimed = ctx.repo.claimNext();
    expect(claimed?.id).toBe(a.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.startedAt).not.toBeNull();
    // Second claim picks b
    const claimed2 = ctx.repo.claimNext();
    expect(claimed2?.id).toBe(b.id);
  });

  it("claimNext returns null when queue is empty", () => {
    expect(ctx.repo.claimNext()).toBeNull();
  });

  it("updateProgress clamps progress to [0, 100] and stores the message", () => {
    const job = ctx.repo.create({ source: "/a", options: {} });
    ctx.repo.updateProgress(job.id, 250, "almost there");
    expect(ctx.repo.findById(job.id)?.progress).toBe(100);
    ctx.repo.updateProgress(job.id, -5);
    expect(ctx.repo.findById(job.id)?.progress).toBe(0);
    ctx.repo.updateProgress(job.id, 42, "halfway");
    const got = ctx.repo.findById(job.id);
    expect(got?.progress).toBe(42);
    expect(got?.message).toBe("halfway");
  });

  it("markSucceeded sets status, progress=100, result, finishedAt", () => {
    const job = ctx.repo.create({ source: "/a", options: {} });
    ctx.repo.markSucceeded(job.id, {
      id: "s1", slug: "a", name: "A", version: "0.0.1",
      fileCount: 3, action: "created", tags: ["x"],
    });
    const got = ctx.repo.findById(job.id);
    expect(got?.status).toBe("succeeded");
    expect(got?.progress).toBe(100);
    expect(got?.result?.slug).toBe("a");
    expect(got?.finishedAt).not.toBeNull();
  });

  it("markFailed sets status, error, finishedAt; keeps result null", () => {
    const job = ctx.repo.create({ source: "/a", options: {} });
    ctx.repo.markFailed(job.id, "boom");
    const got = ctx.repo.findById(job.id);
    expect(got?.status).toBe("failed");
    expect(got?.errorMessage).toBe("boom");
    expect(got?.result).toBeNull();
    expect(got?.finishedAt).not.toBeNull();
  });

  it("recoverOrphans flips running rows back to queued, returns the count", () => {
    const a = ctx.repo.create({ source: "/a", options: {} });
    const b = ctx.repo.create({ source: "/b", options: {} });
    ctx.repo.claimNext();
    ctx.repo.claimNext();
    expect(ctx.repo.findById(a.id)?.status).toBe("running");
    expect(ctx.repo.findById(b.id)?.status).toBe("running");

    const recovered = ctx.repo.recoverOrphans();
    expect(recovered).toBe(2);
    expect(ctx.repo.findById(a.id)?.status).toBe("queued");
    expect(ctx.repo.findById(b.id)?.status).toBe("queued");
    // startedAt is cleared so the next claim re-stamps it
    expect(ctx.repo.findById(a.id)?.startedAt).toBeNull();
  });

  it("list filters by status when provided", () => {
    ctx.repo.create({ source: "/a", options: {} });
    const b = ctx.repo.create({ source: "/b", options: {} });
    ctx.repo.markFailed(b.id, "x");
    expect(ctx.repo.list({ status: "queued" }).map(j => j.source)).toEqual(["/a"]);
    expect(ctx.repo.list({ status: "failed" }).map(j => j.source)).toEqual(["/b"]);
    expect(ctx.repo.list().length).toBe(2);
  });

  it("survives a corrupt options_json by falling back to {}", () => {
    const job = ctx.repo.create({ source: "/a", options: { tags: ["x"] } });
    ctx.db.run(`UPDATE import_jobs SET options_json = '{not json' WHERE id = '${job.id}'`);
    const got = ctx.repo.findById(job.id);
    expect(got?.options).toEqual({});
  });
});
