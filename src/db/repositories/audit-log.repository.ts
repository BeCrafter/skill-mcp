import { eq, and } from "drizzle-orm";
import type { DrizzleDB } from "../connection.js";
import { auditLogs } from "../schema.js";
import { generateId } from "../../utils/id.js";

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  operatorId: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  createdAt: number;
}

export class AuditLogRepository {
  constructor(private db: DrizzleDB) {}

  log(entry: { action: string; entityType: string; entityId: string; operatorId?: string; before?: unknown; after?: unknown }): void {
    this.db.insert(auditLogs).values({
      id: generateId("aud_"),
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      operatorId: entry.operatorId ?? null,
      beforeJson: entry.before ? JSON.stringify(entry.before) : null,
      afterJson: entry.after ? JSON.stringify(entry.after) : null,
      createdAt: Date.now(),
    }).run();
  }

  findByEntity(entityType: string, entityId: string, limit = 50): AuditLogEntry[] {
    return this.db.select().from(auditLogs)
      .where(and(eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, entityId)))
      .orderBy(auditLogs.createdAt)
      .limit(limit)
      .all();
  }
}
