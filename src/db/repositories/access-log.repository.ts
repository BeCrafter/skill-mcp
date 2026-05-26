import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "../connection.js";
import { accessLogs } from "../schema.js";
import type { AccessLogEntry } from "../../types/index.js";
import { getLogger } from "../../utils/logger.js";

export class AccessLogRepository {
  constructor(private db: DrizzleDB) {}

  async create(entry: Omit<AccessLogEntry, "id" | "createdAt">): Promise<void> {
    this.db.insert(accessLogs).values({
      id: randomUUID(),
      skillId: entry.skillId,
      skillSlug: entry.skillSlug,
      action: entry.action,
      filePaths: entry.filePaths ? JSON.stringify(entry.filePaths) : null,
      latencyMs: entry.latencyMs ?? null,
      userId: entry.userId ?? null,
      sessionId: entry.sessionId ?? null,
      createdAt: Date.now(),
    }).run();
  }

  async findBySkill(skillSlug: string, limit: number = 50): Promise<AccessLogEntry[]> {
    const rows = this.db.select().from(accessLogs)
      .where(eq(accessLogs.skillSlug, skillSlug))
      .limit(limit)
      .all();

    // T-716 — same defensive parse as PipelineRunRepository.findById (T-501).
    // `filePaths` is a TEXT JSON blob; one corrupt row used to bubble a raw
    // SyntaxError out of the admin audit endpoint and 500 the whole listing.
    // Drop the malformed value (treat as undefined) and keep serving the rest.
    const logger = getLogger();
    return rows.map(row => {
      let filePaths: string[] | undefined;
      if (row.filePaths) {
        try {
          const parsed = JSON.parse(row.filePaths);
          filePaths = Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : undefined;
          if (filePaths === undefined) {
            logger.warn({ rowId: row.id }, "access_log.file_paths is not a string array; dropping value");
          }
        } catch (err) {
          logger.warn({ err, rowId: row.id }, "Failed to parse access_log.file_paths JSON; dropping value");
        }
      }
      return {
        id: row.id,
        skillId: row.skillId,
        skillSlug: row.skillSlug,
        action: row.action as AccessLogEntry["action"],
        filePaths,
        latencyMs: row.latencyMs ?? undefined,
        userId: row.userId ?? undefined,
        sessionId: row.sessionId ?? undefined,
        createdAt: row.createdAt,
      };
    });
  }
}
