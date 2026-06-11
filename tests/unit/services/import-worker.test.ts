import { describe, it, expect, vi, beforeEach } from "vitest";
import { BackgroundImportWorker } from "@/services/import-worker.js";
import type { ImportJobEntity, ImportJobRepository } from "@/db/repositories/import-job.repository.js";
import type { SkillImporter } from "@/import/importer.js";

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

function makeJob(over: Partial<ImportJobEntity> = {}): ImportJobEntity {
  return {
    id: "j1",
    status: "running",
    source: "/tmp/x",
    options: {},
    progress: 0,
    message: null,
    result: null,
    errorMessage: null,
    createdByUserId: null,
    createdAt: 1,
    startedAt: 2,
    finishedAt: null,
    ...over,
  };
}

function makeRepo() {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    claimNext: vi.fn(),
    updateProgress: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(),
    recoverOrphans: vi.fn().mockReturnValue(0),
    list: vi.fn(),
  } as unknown as ImportJobRepository & {
    [K in "create" | "findById" | "claimNext" | "updateProgress" | "markSucceeded" | "markFailed" | "recoverOrphans" | "list"]: ReturnType<typeof vi.fn>;
  };
}

function makeImporter(impl: SkillImporter["import"] = vi.fn()) {
  return { import: impl } as unknown as SkillImporter;
}

describe("BackgroundImportWorker (P0-10)", () => {
  let repo: ReturnType<typeof makeRepo>;
  beforeEach(() => { repo = makeRepo(); });

  it("constructor calls recoverOrphans by default and logs when count > 0", () => {
    repo.recoverOrphans.mockReturnValue(3);
    const log = fakeLogger();
    new BackgroundImportWorker(repo, makeImporter(), log, { skipRecovery: false });
    expect(repo.recoverOrphans).toHaveBeenCalledTimes(1);
    expect((log as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });

  it("skipRecovery: true bypasses recoverOrphans on construction", () => {
    new BackgroundImportWorker(repo, makeImporter(), fakeLogger(), { skipRecovery: true });
    expect(repo.recoverOrphans).not.toHaveBeenCalled();
  });

  it("tick() returns false when queue is empty and does not call importer", async () => {
    repo.claimNext.mockReturnValue(null);
    const importer = makeImporter(vi.fn());
    const w = new BackgroundImportWorker(repo, importer, fakeLogger(), { skipRecovery: true });
    expect(await w.tick()).toBe(false);
    expect((importer.import as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("tick() success path: bumps progress, calls importer, marks succeeded", async () => {
    const job = makeJob({ source: "/src", options: { tags: ["x"] } });
    repo.claimNext.mockReturnValue(job);
    const importResult = { id: "s1", slug: "a", name: "A", version: "0.0.1", fileCount: 1, action: "created" as const, tags: ["x"] };
    const importerFn = vi.fn().mockResolvedValue(importResult);
    const w = new BackgroundImportWorker(repo, makeImporter(importerFn), fakeLogger(), { skipRecovery: true });
    expect(await w.tick()).toBe(true);
    expect(repo.updateProgress).toHaveBeenCalledWith(job.id, 5, "Starting import");
    expect(importerFn).toHaveBeenCalledWith("/src", { tags: ["x"] });
    expect(repo.markSucceeded).toHaveBeenCalledWith(job.id, importResult);
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it("tick() failure path: marks failed with error message; does not throw", async () => {
    const job = makeJob();
    repo.claimNext.mockReturnValue(job);
    const importerFn = vi.fn().mockRejectedValue(new Error("kaboom"));
    const w = new BackgroundImportWorker(repo, makeImporter(importerFn), fakeLogger(), { skipRecovery: true });
    await expect(w.tick()).resolves.toBe(true);
    expect(repo.markFailed).toHaveBeenCalledWith(job.id, "kaboom");
    expect(repo.markSucceeded).not.toHaveBeenCalled();
  });

  it("tick() failure path: stringifies non-Error throws", async () => {
    const job = makeJob();
    repo.claimNext.mockReturnValue(job);
    const importerFn = vi.fn().mockRejectedValue("nope");
    const w = new BackgroundImportWorker(repo, makeImporter(importerFn), fakeLogger(), { skipRecovery: true });
    await w.tick();
    expect(repo.markFailed).toHaveBeenCalledWith(job.id, "nope");
  });

  it("start() drains queued jobs then idles; stop() awaits in-flight", async () => {
    const job1 = makeJob({ id: "a" });
    const job2 = makeJob({ id: "b" });
    let calls = 0;
    repo.claimNext.mockImplementation(() => {
      calls++;
      if (calls === 1) return job1;
      if (calls === 2) return job2;
      return null;
    });
    const importerFn = vi.fn().mockResolvedValue({ id: "x", slug: "x", name: "x", version: "0", fileCount: 0, action: "created" as const });
    const w = new BackgroundImportWorker(repo, makeImporter(importerFn), fakeLogger(), { pollIntervalMs: 5, skipRecovery: true });
    w.start();
    // Wait long enough for both jobs to be drained
    await new Promise(r => setTimeout(r, 80));
    await w.stop();
    expect(importerFn).toHaveBeenCalledTimes(2);
    expect(repo.markSucceeded).toHaveBeenCalledTimes(2);
  });

  it("start() is idempotent (calling twice does not double-schedule)", async () => {
    repo.claimNext.mockReturnValue(null);
    const w = new BackgroundImportWorker(repo, makeImporter(vi.fn()), fakeLogger(), { pollIntervalMs: 5, skipRecovery: true });
    w.start();
    w.start();
    await new Promise(r => setTimeout(r, 30));
    await w.stop();
    // claimNext is called per tick; we just verify nothing exploded and stop resolves.
    expect(repo.claimNext).toHaveBeenCalled();
  });

  it("stop() before start() resolves cleanly", async () => {
    const w = new BackgroundImportWorker(repo, makeImporter(vi.fn()), fakeLogger(), { skipRecovery: true });
    await expect(w.stop()).resolves.toBeUndefined();
  });
});
