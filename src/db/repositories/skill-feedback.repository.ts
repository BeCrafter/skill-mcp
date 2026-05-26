import { and, eq, gte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "../connection.js";
import { skillFeedbacks } from "../schema.js";

export interface SkillFeedbackEntry {
  id: string;
  skillId: string;
  skillSlug: string;
  userId: string | null;
  sessionId: string | null;
  outcome: string;
  context: string | null;
  agentComment: string | null;
  createdAt: number;
}

export class SkillFeedbackRepository {
  constructor(private db: DrizzleDB) {}

  async create(entry: Omit<SkillFeedbackEntry, "id" | "createdAt">): Promise<string> {
    const id = randomUUID();
    this.db.insert(skillFeedbacks).values({
      id,
      skillId: entry.skillId,
      skillSlug: entry.skillSlug,
      userId: entry.userId ?? null,
      sessionId: entry.sessionId ?? null,
      outcome: entry.outcome,
      context: entry.context ?? null,
      agentComment: entry.agentComment ?? null,
      createdAt: Date.now(),
    }).run();
    return id;
  }

  // T-713 — `feedbacks` is user-insertable and can grow without bound, so
  // returning the entire row set per slug ballooned memory under heavy
  // feedback volume. Default cap = 1000; callers can opt-in to larger
  // pages but the unbounded path is gone. Most-recent-first so the rate
  // computed by callers reflects current user experience, not the dawn
  // of the skill's life.
  async findBySlug(slug: string, days?: number, limit = 1000): Promise<SkillFeedbackEntry[]> {
    const conditions = [eq(skillFeedbacks.skillSlug, slug)];
    if (days) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      conditions.push(gte(skillFeedbacks.createdAt, cutoff));
    }
    const rows = this.db.select().from(skillFeedbacks)
      .where(and(...conditions))
      .orderBy(sql`${skillFeedbacks.createdAt} desc`)
      .limit(limit)
      .all();
    return rows.map(r => ({
      id: r.id,
      skillId: r.skillId,
      skillSlug: r.skillSlug,
      userId: r.userId,
      sessionId: r.sessionId,
      outcome: r.outcome,
      context: r.context,
      agentComment: r.agentComment,
      createdAt: r.createdAt,
    }));
  }

  async getEffectivenessRates(days?: number): Promise<Map<string, { rate: number; count: number }>> {
    const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
    const rows = this.db
      .select({
        skillSlug: skillFeedbacks.skillSlug,
        total: sql<number>`count(*)`,
        successCount: sql<number>`sum(case when ${skillFeedbacks.outcome} = 'success' or ${skillFeedbacks.outcome} = 'partial' then 1 else 0 end)`,
      })
      .from(skillFeedbacks)
      .where(cutoff > 0 ? gte(skillFeedbacks.createdAt, cutoff) : undefined)
      .groupBy(skillFeedbacks.skillSlug)
      .all();

    const result = new Map<string, { rate: number; count: number }>();
    for (const row of rows) {
      const rate = row.total > 0 ? row.successCount / row.total : 0.5;
      result.set(row.skillSlug, { rate, count: row.total });
    }
    return result;
  }
}
