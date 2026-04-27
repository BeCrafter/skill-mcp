import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "../connection.js";
import { accessLogs } from "../schema.js";
import type { AccessLogEntry } from "../../types/index.js";

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
      createdAt: Date.now(),
    }).run();
  }

  async findBySkill(skillSlug: string, limit: number = 50): Promise<AccessLogEntry[]> {
    const rows = this.db.select().from(accessLogs)
      .where(eq(accessLogs.skillSlug, skillSlug))
      .limit(limit)
      .all();

    return rows.map(row => ({
      id: row.id,
      skillId: row.skillId,
      skillSlug: row.skillSlug,
      action: row.action as AccessLogEntry["action"],
      filePaths: row.filePaths ? JSON.parse(row.filePaths) : undefined,
      latencyMs: row.latencyMs ?? undefined,
      createdAt: row.createdAt,
    }));
  }
}
