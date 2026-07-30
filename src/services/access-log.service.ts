import type { Logger } from "pino";
import type { AccessLogRepository } from "../db/repositories/access-log.repository.js";
import type { AccessLogEntry } from "../types/index.js";

export class AccessLogService {
  constructor(
    private logRepo: AccessLogRepository,
    private logger: Logger,
  ) {}

  async log(entry: Omit<AccessLogEntry, "id" | "createdAt">): Promise<void> {
    try {
      await this.logRepo.create(entry);
    } catch (error) {
      this.logger.error({ error, entry }, "Failed to write access log");
    }
  }
}
