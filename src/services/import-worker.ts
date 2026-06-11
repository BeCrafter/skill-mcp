import type { Logger } from "pino";
import type { SkillImporter } from "../import/importer.js";
import type { ImportJobRepository, ImportJobEntity } from "../db/repositories/import-job.repository.js";

// P0-10 — single-process background worker for async skill imports.
//
// Why an in-process worker? §11 in the commercialization review allocates 3
// person-days for P0-10; a real queue (Redis/BullMQ/Postgres-NOTIFY) is
// scoped to P1 (#15). The in-process variant unblocks large-payload imports
// today while keeping the API contract (POST 202 + GET /jobs/:id) compatible
// with the future external-queue refactor — only the worker implementation
// changes.
//
// The worker runs on a polling loop; an unstarted instance has no effect, so
// unit tests can omit it. Only one worker should exist per process; concurrent
// workers in the same process are safe (claimNext is atomic) but pointless.
export interface ImportWorkerOptions {
  pollIntervalMs?: number;
  /** When true, skip recoverOrphans() on start. Tests use this to keep state stable. */
  skipRecovery?: boolean;
}

export class BackgroundImportWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly jobRepo: ImportJobRepository,
    private readonly importer: SkillImporter,
    private readonly logger: Logger,
    options: ImportWorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    if (!options.skipRecovery) {
      const recovered = this.jobRepo.recoverOrphans();
      if (recovered > 0) {
        this.logger.warn({ recovered }, "import worker: requeued orphaned running jobs");
      }
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      try { await this.inFlight; } catch { /* swallowed; logged in tick */ }
    }
  }

  /** Claim and process one job. Exposed for tests and one-shot invocation. */
  async tick(): Promise<boolean> {
    const job = this.jobRepo.claimNext();
    if (!job) return false;
    await this.processJob(job);
    return true;
  }

  private scheduleTick(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.tick()
        .then(processed => {
          // If we processed a job there might be more; poll immediately.
          // Otherwise back off to the configured interval.
          this.scheduleTick(processed ? 0 : this.pollIntervalMs);
        })
        .catch(err => {
          this.logger.error({ err }, "import worker tick error");
          this.scheduleTick(this.pollIntervalMs);
        })
        .finally(() => { this.inFlight = null; });
    }, delayMs);
  }

  private async processJob(job: ImportJobEntity): Promise<void> {
    this.logger.info({ jobId: job.id, source: job.source }, "import worker: processing job");
    this.jobRepo.updateProgress(job.id, 5, "Starting import");
    try {
      const result = await this.importer.import(job.source, job.options);
      this.jobRepo.markSucceeded(job.id, result);
      this.logger.info({ jobId: job.id, slug: result.slug, action: result.action }, "import worker: job succeeded");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.jobRepo.markFailed(job.id, message);
      this.logger.warn({ jobId: job.id, err }, "import worker: job failed");
    }
  }
}
