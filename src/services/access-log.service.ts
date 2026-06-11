import type { Logger } from "pino";
import type { AccessLogRepository } from "../db/repositories/access-log.repository.js";
import type { AccessLogEntry } from "../types/index.js";
import { withSpan } from "../telemetry/spans.js";

export class AccessLogService {
  constructor(
    private logRepo: AccessLogRepository,
    private logger: Logger,
  ) {}

  async log(entry: Omit<AccessLogEntry, "id" | "createdAt">): Promise<void> {
    // P0-6 — `audit.write` span (§17.6). We swallow exceptions here (audit
    // logging must never crash a request), but the span still records the
    // failure so traces stay informative.
    await withSpan("audit.write", { attributes: { "audit.action": entry.action, "audit.skill_slug": entry.skillSlug } }, async () => {
      try {
        await this.logRepo.create(entry);
      } catch (error) {
        this.logger.error({ error, entry }, "Failed to write access log");
      }
    });
  }
}
