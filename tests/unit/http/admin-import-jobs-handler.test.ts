import { describe, it, expect, vi, beforeEach } from "vitest";
import { Router } from "@/http/router.js";
import { errorMap } from "@/http/middleware/error-map.js";
import { registerAdminImportJobRoutes } from "@/http/handlers/admin/import-jobs.handler.js";
import type { HttpContext } from "@/http/context.js";
import type { AppDependencies } from "@/app-dependencies.js";
import type { ImportJobEntity, ImportJobRepository } from "@/db/repositories/import-job.repository.js";

function makeRes() {
  let body = "";
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 0,
    writeHead: vi.fn((status: number, h?: Record<string, unknown>) => {
      res.statusCode = status;
      if (h) Object.assign(headers, h);
    }),
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn((chunk?: string | Buffer) => { if (chunk) body += chunk.toString(); }),
    _body: () => body,
    _headers: () => headers,
  };
  return res as never;
}

function makeCtx(method: string, url: string, body?: unknown, requestContext?: { userId: string }): HttpContext {
  const req = {
    headers: { "content-type": "application/json" },
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "data" && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
      return this;
    },
  } as never;
  return {
    req, res: makeRes(),
    url, method, params: {}, query: new URLSearchParams(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    requestContext: requestContext ? ({ userId: requestContext.userId, tags: [], isAnonymous: false } as never) : undefined,
  };
}

function bodyOf(ctx: HttpContext) {
  const r = ctx.res as unknown as { statusCode: number; _body: () => string };
  return { statusCode: r.statusCode, body: JSON.parse(r._body()) };
}

function makeJob(over: Partial<ImportJobEntity> = {}): ImportJobEntity {
  return {
    id: "j1",
    status: "queued",
    source: "/tmp/x",
    options: { tags: ["secret-token"] },
    progress: 0,
    message: null,
    result: null,
    errorMessage: null,
    createdByUserId: null,
    createdAt: 1,
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

function setup() {
  const importJobRepo = {
    create: vi.fn((args) => makeJob({ id: "new-id", source: args.source, options: args.options, createdByUserId: args.createdByUserId ?? null })),
    findById: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    claimNext: vi.fn(),
    updateProgress: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(),
    recoverOrphans: vi.fn(),
  } as unknown as ImportJobRepository & Record<string, ReturnType<typeof vi.fn>>;
  const router = new Router();
  router.use(errorMap("Admin operation failed"));
  registerAdminImportJobRoutes(router, { importJobRepo } as unknown as AppDependencies);
  return { importJobRepo, router };
}

describe("registerAdminImportJobRoutes (P0-10)", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("POST /api/admin/skills/import/async returns 202 with job_id and poll_url", async () => {
    const httpCtx = makeCtx("POST", "/api/admin/skills/import/async", {
      source: "/tmp/skill", tags: ["x"], version_bump: "minor",
    }, { userId: "u-42" });
    await ctx.router.dispatch(httpCtx);
    const out = bodyOf(httpCtx);
    expect(out.statusCode).toBe(202);
    expect(out.body.success).toBe(true);
    expect(out.body.data.job_id).toBe("new-id");
    expect(out.body.data.status).toBe("queued");
    expect(out.body.data.poll_url).toBe("/api/v1/admin/jobs/new-id");
    expect(ctx.importJobRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      source: "/tmp/skill",
      createdByUserId: "u-42",
      options: expect.objectContaining({ tags: ["x"], versionBump: "minor", overwrite: false, allowDuplicate: false }),
    }));
  });

  it("POST without source -> 400 BadRequestError", async () => {
    const httpCtx = makeCtx("POST", "/api/admin/skills/import/async", {});
    await ctx.router.dispatch(httpCtx);
    const out = bodyOf(httpCtx);
    expect(out.statusCode).toBe(400);
    expect(out.body.success).toBe(false);
  });

  it("POST multipart/form-data -> 400 (zip upload not yet supported)", async () => {
    const httpCtx = makeCtx("POST", "/api/admin/skills/import/async", { source: "/x" });
    (httpCtx.req as unknown as { headers: Record<string, string> }).headers["content-type"] = "multipart/form-data; boundary=----x";
    await ctx.router.dispatch(httpCtx);
    expect(bodyOf(httpCtx).statusCode).toBe(400);
  });

  it("GET /api/admin/jobs/:jobId returns the job view without echoing options", async () => {
    const job = makeJob({ id: "j-7", status: "succeeded", progress: 100, options: { tags: ["secret"], branch: "main" } });
    ctx.importJobRepo.findById.mockReturnValue(job);
    const httpCtx = makeCtx("GET", "/api/admin/jobs/j-7");
    await ctx.router.dispatch(httpCtx);
    const out = bodyOf(httpCtx);
    expect(out.statusCode).toBe(200);
    expect(out.body.data.id).toBe("j-7");
    expect(out.body.data.status).toBe("succeeded");
    expect(out.body.data.progress).toBe(100);
    // Critical: options must NOT be echoed back (P0-10 secrets-in-source guard)
    expect(out.body.data.options).toBeUndefined();
  });

  it("GET unknown jobId -> 404 IMPORT_JOB_NOT_FOUND", async () => {
    ctx.importJobRepo.findById.mockReturnValue(null);
    const httpCtx = makeCtx("GET", "/api/admin/jobs/missing");
    await ctx.router.dispatch(httpCtx);
    const out = bodyOf(httpCtx);
    expect(out.statusCode).toBe(404);
    expect(out.body.error?.code ?? out.body.code).toBeTruthy();
  });

  it("GET /api/admin/jobs/:jobId/progress returns lightweight projection", async () => {
    const job = makeJob({ id: "j-8", status: "running", progress: 42, message: "halfway" });
    ctx.importJobRepo.findById.mockReturnValue(job);
    const httpCtx = makeCtx("GET", "/api/admin/jobs/j-8/progress");
    await ctx.router.dispatch(httpCtx);
    const out = bodyOf(httpCtx);
    expect(out.statusCode).toBe(200);
    expect(out.body.data).toEqual({ id: "j-8", status: "running", progress: 42, message: "halfway" });
  });

  it("GET /api/admin/jobs lists jobs and respects status filter", async () => {
    const j1 = makeJob({ id: "a", status: "queued" });
    const j2 = makeJob({ id: "b", status: "failed", errorMessage: "boom" });
    ctx.importJobRepo.list.mockImplementation((opts: { status?: string }) => {
      if (opts?.status === "failed") return [j2];
      return [j1, j2];
    });
    const httpCtx = makeCtx("GET", "/api/admin/jobs");
    await ctx.router.dispatch(httpCtx);
    expect(bodyOf(httpCtx).body.total).toBe(2);

    const httpCtx2 = makeCtx("GET", "/api/admin/jobs");
    httpCtx2.query.set("status", "failed");
    await ctx.router.dispatch(httpCtx2);
    const out2 = bodyOf(httpCtx2);
    expect(out2.body.total).toBe(1);
    expect(out2.body.data[0].id).toBe("b");
    expect(out2.body.data[0].error).toBe("boom");
  });

  it("GET /api/admin/jobs ignores invalid status filter values", async () => {
    ctx.importJobRepo.list.mockReturnValue([makeJob()]);
    const httpCtx = makeCtx("GET", "/api/admin/jobs");
    httpCtx.query.set("status", "totally-bogus");
    await ctx.router.dispatch(httpCtx);
    expect(ctx.importJobRepo.list).toHaveBeenCalledWith(expect.objectContaining({ status: undefined }));
  });

  it("does nothing when importJobRepo is missing from deps", () => {
    const router = new Router();
    expect(() => registerAdminImportJobRoutes(router, {} as unknown as AppDependencies)).not.toThrow();
  });
});
