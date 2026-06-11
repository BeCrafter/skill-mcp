import type { Logger } from "pino";
import type { WebhookDispatcher } from "./webhook-dispatcher.js";

// P1-16 — background webhook retry worker.
//
// Polls `webhook_deliveries` for due rows (`status='pending' AND
// next_retry_at <= now`) and hands each to the dispatcher. Single in-process
// worker per node; the `idx_webhook_deliveries_due` index keeps lookups cheap
// even with millions of historical rows.
//
// Mirrors `BackgroundImportWorker` (P0-10): polling timer + per-tick claim,
// `start()` / `stop()` lifecycle. No external queue dep; if multiple gateway
// processes share a DB the only race is duplicate delivery (better-sqlite3
// transactions serialize the read+update inside `recordAttempt`).

export interface WebhookWorkerOptions {
  /** Poll interval when no rows were due last tick. Default 5s. */
  idlePollIntervalMs?: number;
  /** Burst-poll interval when work was found. Default 200ms — keeps a
   *  backlog draining quickly without hammering an empty queue. */
  busyPollIntervalMs?: number;
  /** Max rows handled per tick. Default 32. */
  batchSize?: number;
}

export class WebhookWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private readonly idlePollIntervalMs: number;
  private readonly busyPollIntervalMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly logger: Logger,
    options: WebhookWorkerOptions = {},
  ) {
    this.idlePollIntervalMs = options.idlePollIntervalMs ?? 5000;
    this.busyPollIntervalMs = options.busyPollIntervalMs ?? 200;
    this.batchSize = options.batchSize ?? 32;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info("webhook worker: starting");
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      try { await this.inFlight; } catch { /* swallowed */ }
    }
    this.logger.info("webhook worker: stopped");
  }

  /** Process up to `batchSize` due rows. Exposed for tests. */
  async tick(): Promise<number> {
    const results = await this.dispatcher.dispatchDue(this.batchSize);
    return results.length;
  }

  private scheduleTick(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.tick()
        .then(processed => {
          this.scheduleTick(processed > 0 ? this.busyPollIntervalMs : this.idlePollIntervalMs);
        })
        .catch(err => {
          this.logger.error({ err }, "webhook worker tick error");
          this.scheduleTick(this.idlePollIntervalMs);
        })
        .finally(() => { this.inFlight = null; });
    }, delayMs);
  }
}
