import type { Router } from "../../router.js";
import type { AppDependencies } from "../../../app.js";
import { json, readJsonBody } from "../../helpers.js";
import { AppError, BadRequestError } from "../../../utils/errors.js";
import type { ImportJobEntity } from "../../../db/repositories/import-job.repository.js";

class ImportJobNotFoundError extends AppError {
  constructor(id: string) {
    super(`Import job not found: ${id}`, "IMPORT_JOB_NOT_FOUND", 404);
    this.name = "ImportJobNotFoundError";
  }
}

// P0-10 — async-import projection. We deliberately do NOT echo `options` back
// to clients on every poll: the source / token / branch may carry secrets that
// the operator passed when enqueueing. Operators who need them can read the
// row directly from the DB.
function toJobView(job: ImportJobEntity) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    source: job.source,
    result: job.result,
    error: job.errorMessage,
    created_by_user_id: job.createdByUserId,
    created_at: job.createdAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
  };
}

export function registerAdminImportJobRoutes(router: Router, deps: AppDependencies): void {
  if (!deps.importJobRepo) return;
  const { importJobRepo } = deps;

  router.post("/api/admin/skills/import/async", async (ctx) => {
    const contentType = ctx.req.headers["content-type"] ?? "";
    if (contentType.includes("multipart/form-data")) {
      throw new BadRequestError("ZIP upload not yet supported, use JSON body with source path");
    }
    const data = await readJsonBody<{
      source?: string;
      category?: string;
      tags?: string[];
      description?: string;
      target_id?: string;
      version_bump?: "major" | "minor" | "patch";
      overwrite?: boolean;
      allow_duplicate?: boolean;
      slug?: string;
      branch?: string;
      sub_dir?: string;
    }>(ctx.req);
    if (!data.source) throw new BadRequestError("source is required");

    const job = await importJobRepo.create({
      source: data.source,
      options: {
        category: data.category,
        tags: data.tags,
        description: data.description,
        targetId: data.target_id,
        versionBump: data.version_bump ?? "patch",
        overwrite: data.overwrite ?? false,
        allowDuplicate: data.allow_duplicate ?? false,
        slug: data.slug,
        branch: data.branch,
        subDir: data.sub_dir,
      },
      createdByUserId: ctx.requestContext?.userId ?? null,
    });
    // 202 Accepted — request received, processing async; client should poll
    // GET /api/v1/admin/jobs/:jobId for terminal state.
    json(ctx.res, 202, {
      success: true,
      data: {
        job_id: job.id,
        status: job.status,
        poll_url: `/api/v1/admin/jobs/${job.id}`,
      },
    });
  });

  router.get("/api/admin/jobs", async (ctx) => {
    const status = ctx.query.get("status") as ImportJobEntity["status"] | null;
    const limit = parseInt(ctx.query.get("limit") ?? "50", 10);
    const validStatus = status && ["queued", "running", "succeeded", "failed"].includes(status)
      ? status
      : undefined;
    const jobs = importJobRepo.list({ status: validStatus, limit });
    json(ctx.res, 200, {
      success: true,
      data: jobs.map(toJobView),
      total: jobs.length,
    });
  });

  router.get("/api/admin/jobs/:jobId", async (ctx) => {
    const job = importJobRepo.findById(ctx.params.jobId);
    if (!job) throw new ImportJobNotFoundError(ctx.params.jobId);
    json(ctx.res, 200, { success: true, data: toJobView(job) });
  });

  // /progress is a thin alias used by clients that just want the progress
  // counter (e.g. shell scripts) without the full job DTO.
  router.get("/api/admin/jobs/:jobId/progress", async (ctx) => {
    const job = importJobRepo.findById(ctx.params.jobId);
    if (!job) throw new ImportJobNotFoundError(ctx.params.jobId);
    json(ctx.res, 200, {
      success: true,
      data: {
        id: job.id,
        status: job.status,
        progress: job.progress,
        message: job.message,
      },
    });
  });
}
