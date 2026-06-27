import { and, eq, gte, sql, desc } from "drizzle-orm";
import { shortId, generateUniqueId } from "../../utils/id.js";
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
  version: string | null;
  createdAt: number;
}

export class SkillFeedbackRepository {
  constructor(private db: DrizzleDB) {}

  async create(entry: Omit<SkillFeedbackEntry, "id" | "createdAt">): Promise<string> {
    const id = await generateUniqueId(() => shortId(), async (id) => {
      const row = this.db.select({ id: skillFeedbacks.id }).from(skillFeedbacks).where(eq(skillFeedbacks.id, id)).get();
      return !!row;
    });
    this.db.insert(skillFeedbacks).values({
      id,
      skillId: entry.skillId,
      skillSlug: entry.skillSlug,
      userId: entry.userId ?? null,
      sessionId: entry.sessionId ?? null,
      outcome: entry.outcome,
      context: entry.context ?? null,
      agentComment: entry.agentComment ?? null,
      version: entry.version ?? null,
      createdAt: Date.now(),
    }).run();
    return id;
  }

  async findBySlug(slug: string, days?: number, limit = 1000): Promise<SkillFeedbackEntry[]> {
    const conditions = [eq(skillFeedbacks.skillSlug, slug)];
    if (days) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      conditions.push(gte(skillFeedbacks.createdAt, cutoff));
    }
    return this.db.select().from(skillFeedbacks)
      .where(and(...conditions))
      .orderBy(desc(skillFeedbacks.createdAt))
      .limit(limit)
      .all() as SkillFeedbackEntry[];
  }

  getEffectivenessRates(days?: number): Map<string, { rate: number; count: number }> {
    const conditions: ReturnType<typeof eq>[] = [];
    if (days) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      conditions.push(gte(skillFeedbacks.createdAt, cutoff));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = this.db.select({
      slug: skillFeedbacks.skillSlug,
      total: sql<number>`count(*)`,
      positive: sql<number>`sum(case when ${skillFeedbacks.outcome} in ('success','partial') then 1 else 0 end)`,
    }).from(skillFeedbacks)
      .where(where)
      .groupBy(skillFeedbacks.skillSlug)
      .all();

    const result = new Map<string, { rate: number; count: number }>();
    for (const r of rows) {
      result.set(r.slug, {
        rate: r.total > 0 ? r.positive / r.total : 0.5,
        count: r.total,
      });
    }
    return result;
  }
}
