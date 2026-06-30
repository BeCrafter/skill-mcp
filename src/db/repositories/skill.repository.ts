import { eq, and, sql, inArray, type SQL } from "drizzle-orm";
import { generateId, generateUniqueId } from "../../utils/id.js";
import type { DrizzleDB } from "../connection.js";
import { skills, skillTags } from "../schema.js";
import type { SkillMeta, SkillMetaInput, SkillRetrievalMeta, SkillStatus, VersionBump } from "../../types/index.js";
import { metrics } from "../../telemetry/metrics.js";
import { getLogger } from "../../utils/logger.js";
import { withSpanSync } from "../../telemetry/spans.js";

const REPO = "skill";

function timed<T>(method: string, fn: () => T): T {
  // P0-6 — `db.query` span (§17.6) wraps the existing prom-client timer so
  // every method already routed through `timed()` gets a trace span without
  // touching individual call sites. Sync variant because better-sqlite3 is
  // synchronous; the OTel API allows nesting inside an active async parent.
  const end = metrics.dbQueryDuration.startTimer({ repo: REPO, method });
  try {
    const result = withSpanSync("db.query", { attributes: { "db.repo": REPO, "db.method": method } }, fn);
    end({ status: "ok" });
    return result;
  } catch (err) {
    end({ status: "error" });
    throw err;
  }
}

/**
 * T-721 — Hydrate the `skills.attributes` JSON column with corruption visibility.
 * On parse failure: log with skill id + column name, increment the
 * skillRowJsonParseErrors counter, and return an empty object (the only
 * shape attributes is consumed as). Previously returned `[] as T`, which
 * silently produced an array where consumers assumed `Record<string, unknown>`.
 */
function parseAttributes(value: string | null, skillId: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    metrics.skillRowJsonParseErrors.inc({ column: "attributes" });
    getLogger().warn({ skillId, column: "attributes" }, "skills.attributes parsed to non-object; coercing to {}");
    return {};
  } catch (err) {
    metrics.skillRowJsonParseErrors.inc({ column: "attributes" });
    getLogger().warn({ err, skillId, column: "attributes" }, "skills.attributes JSON parse failed");
    return {};
  }
}

/**
 * P1-11 stage 2a — Hydrate the `skills.retrieval_meta` JSON envelope.
 * Mirrors {@link parseAttributes}: corrupt JSON or non-object payloads coerce
 * to `{}` and bump `skillRowJsonParseErrors{column="retrieval_meta"}` so an
 * operator can spot persistent corruption. NULL stays as `null` (legacy
 * rows from before stage 2a) so callers can distinguish "never set" from
 * "set to empty".
 */
function parseRetrievalMeta(value: string | null, skillId: string): SkillRetrievalMeta | null {
  if (value === null || value === undefined) return null;
  if (value === "") return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SkillRetrievalMeta;
    }
    metrics.skillRowJsonParseErrors.inc({ column: "retrieval_meta" });
    getLogger().warn({ skillId, column: "retrieval_meta" }, "skills.retrieval_meta parsed to non-object; coercing to {}");
    return {};
  } catch (err) {
    metrics.skillRowJsonParseErrors.inc({ column: "retrieval_meta" });
    getLogger().warn({ err, skillId, column: "retrieval_meta" }, "skills.retrieval_meta JSON parse failed");
    return {};
  }
}

/**
 * Serialise the retrieval-signal envelope. Returns `null` when the input is
 * either nullish or has no populated fields — the column accepts NULL and
 * we don't want to write `"{}"` strings that consumers would have to special-case.
 */
function serializeRetrievalMeta(value: SkillRetrievalMeta | null | undefined): string | null {
  if (!value) return null;
  const hasTriggers = Array.isArray(value.triggers) && value.triggers.length > 0;
  const hasWhenToUse = typeof value.whenToUse === "string" && value.whenToUse.length > 0;
  const hasEmbeddingText = typeof value.embeddingText === "string" && value.embeddingText.length > 0;
  if (!hasTriggers && !hasWhenToUse && !hasEmbeddingText) return null;
  return JSON.stringify(value);
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export class SkillRepository {
  constructor(private db: DrizzleDB) {}

  async findById(id: string): Promise<SkillMeta | null> {
    return timed("findById", () => {
      const rows = this.db.select().from(skills).where(eq(skills.id, id)).limit(1).all();
      if (rows.length === 0) return null;
      const tagsByIdMap = this.loadTagsForIds([id]);
      return this.toEntity(rows[0], tagsByIdMap.get(id) ?? []);
    });
  }

  async findBySlug(slug: string): Promise<SkillMeta | null> {
    return timed("findBySlug", () => {
      const rows = this.db.select().from(skills).where(eq(skills.slug, slug)).limit(1).all();
      if (rows.length === 0) return null;
      const id = rows[0].id;
      const tagsByIdMap = this.loadTagsForIds([id]);
      return this.toEntity(rows[0], tagsByIdMap.get(id) ?? []);
    });
  }

  async findByName(name: string): Promise<SkillMeta[]> {
    const rows = this.db.select().from(skills).where(eq(skills.name, name)).all();
    const tagsById = this.loadTagsForIds(rows.map(r => r.id));
    return rows.map(r => this.toEntity(r, tagsById.get(r.id) ?? []));
  }

  /**
   * Bulk variant of findById. Issues at most two queries (skills IN + tags IN)
   * regardless of input size, vs. N+1 calls when looping over findById.
   * Empty input short-circuits without hitting SQL.
   */
  async findByIds(ids: string[]): Promise<SkillMeta[]> {
    if (ids.length === 0) return [];
    return timed("findByIds", () => {
      const rows = this.db.select().from(skills).where(inArray(skills.id, ids)).all();
      if (rows.length === 0) return [];
      const tagsById = this.loadTagsForIds(rows.map(r => r.id));
      return rows.map(r => this.toEntity(r, tagsById.get(r.id) ?? []));
    });
  }

  /**
   * Look up a skill by the (name, content_hash) idempotency key. Returns the
   * single row (if any) matching both. Used by the importer to:
   *   1. short-circuit redundant imports of the same payload, and
   *   2. recover after a UNIQUE-conflict from a concurrent winner.
   */
  async findByNameAndHash(name: string, contentHash: string): Promise<SkillMeta | null> {
    return timed("findByNameAndHash", () => {
      const rows = this.db.select().from(skills)
        .where(and(eq(skills.name, name), eq(skills.contentHash, contentHash)))
        .limit(1)
        .all();
      if (rows.length === 0) return null;
      const id = rows[0].id;
      const tagsByIdMap = this.loadTagsForIds([id]);
      return this.toEntity(rows[0], tagsByIdMap.get(id) ?? []);
    });
  }

  async findAll(options?: {
    status?: SkillStatus;
    category?: string;
    tags?: string[];
    visibility?: string;
    attributes?: Record<string, string>;
  }): Promise<SkillMeta[]> {
    const conditions: SQL[] = [];

    if (options?.status) conditions.push(eq(skills.status, options.status));
    if (options?.category) conditions.push(eq(skills.category, options.category));
    if (options?.visibility) conditions.push(eq(skills.visibility, options.visibility));

    // Tag filter via the relation table. Semantics: skill must have ALL
    // requested tags (AND). The subquery counts distinct matches and the
    // outer condition demands the count equals the request size.
    if (options?.tags && options.tags.length > 0) {
      const tagList = options.tags;
      conditions.push(sql`${skills.id} IN (
        SELECT ${skillTags.skillId} FROM ${skillTags}
        WHERE ${inArray(skillTags.tag, tagList)}
        GROUP BY ${skillTags.skillId}
        HAVING COUNT(DISTINCT ${skillTags.tag}) = ${tagList.length}
      )`);
    }

    if (options?.attributes) {
      for (const [key, value] of Object.entries(options.attributes)) {
        // Match JSON key-value: attributes contains "key":"value" or "key": "value"
        const pattern = `%${JSON.stringify(key)}":%${JSON.stringify(value)}%`;
        conditions.push(sql`${skills.attributes} LIKE ${pattern}`);
      }
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    return timed("findAll", () => {
      const rows = this.db.select().from(skills).where(where).all();
      const tagsById = this.loadTagsForIds(rows.map(r => r.id));
      return rows.map(r => this.toEntity(r, tagsById.get(r.id) ?? []));
    });
  }

  async create(input: SkillMetaInput): Promise<SkillMeta> {
    const now = Date.now();
    const id = await generateUniqueId(() => generateId("skl_"), async (id) => !!(await this.findById(id)));
    const tags = input.tags ?? [];

    this.db.transaction((tx) => {
      tx.insert(skills).values({
        id,
        slug: input.slug,
        name: input.name,
        displayName: input.displayName ?? null,
        description: input.description ?? "",
        version: input.version ?? "0.0.1",
        category: input.category ?? null,
        attributes: toJson(input.attributes ?? {}),
        retrievalMeta: serializeRetrievalMeta(input.retrievalMeta),
        status: input.status ?? "draft",
        visibility: input.visibility ?? "private",
        entryFile: input.entryFile ?? "SKILL.md",
        storagePath: input.storagePath ?? `${input.slug}/`,
        contentHash: input.contentHash ?? null,
        importSource: input.importSource ?? null,
        importUrl: input.importUrl ?? null,
        importBranch: input.importBranch ?? null,
        importSubDir: input.importSubDir ?? null,
        importedAt: input.importedAt ?? null,
        createdAt: now,
        updatedAt: now,
      }).run();

      this.replaceTagsTx(tx, id, tags);
    });

    return this.findById(id) as Promise<SkillMeta>;
  }

  async update(id: string, input: Partial<SkillMetaInput>): Promise<SkillMeta | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const updateData: Record<string, unknown> = { updatedAt: Date.now() };

    if (input.description !== undefined) updateData.description = input.description;
    if (input.displayName !== undefined) updateData.displayName = input.displayName;
    if (input.version !== undefined) updateData.version = input.version;
    if (input.category !== undefined) updateData.category = input.category;
    if (input.attributes !== undefined) updateData.attributes = toJson(input.attributes);
    if (input.retrievalMeta !== undefined) {
      updateData.retrievalMeta = serializeRetrievalMeta(input.retrievalMeta);
    }
    if (input.status !== undefined) updateData.status = input.status;
    if (input.visibility !== undefined) updateData.visibility = input.visibility;
    if (input.entryFile !== undefined) updateData.entryFile = input.entryFile;
    if (input.storagePath !== undefined) updateData.storagePath = input.storagePath;
    if (input.contentHash !== undefined) updateData.contentHash = input.contentHash;
    // Import source tracking
    if (input.importSource !== undefined) updateData.importSource = input.importSource;
    if (input.importUrl !== undefined) updateData.importUrl = input.importUrl;
    if (input.importBranch !== undefined) updateData.importBranch = input.importBranch;
    if (input.importSubDir !== undefined) updateData.importSubDir = input.importSubDir;
    if (input.importedAt !== undefined) updateData.importedAt = input.importedAt;

    this.db.transaction((tx) => {
      if (Object.keys(updateData).length > 1) {
        tx.update(skills).set(updateData).where(eq(skills.id, id)).run();
      }
      if (input.tags !== undefined) {
        this.replaceTagsTx(tx, id, input.tags);
      }
    });

    return this.findById(id);
  }

  async delete(slug: string): Promise<boolean> {
    // skill_tags has ON DELETE CASCADE, so deleting from skills cleans up
    // its tag rows automatically.
    const result = this.db.delete(skills).where(eq(skills.slug, slug)).run();
    return result.changes > 0;
  }

  async exists(slug: string): Promise<boolean> {
    const row = this.db.select({ id: skills.id })
      .from(skills)
      .where(eq(skills.slug, slug))
      .limit(1)
      .get();
    return !!row;
  }

  async count(): Promise<number> {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(skills).get();
    return row?.count ?? 0;
  }

  private loadTagsForIds(ids: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (ids.length === 0) return result;
    const rows = this.db.select().from(skillTags).where(inArray(skillTags.skillId, ids)).all();
    for (const row of rows) {
      const arr = result.get(row.skillId);
      if (arr) arr.push(row.tag);
      else result.set(row.skillId, [row.tag]);
    }
    return result;
  }

  private replaceTagsTx(
    tx: Parameters<Parameters<DrizzleDB["transaction"]>[0]>[0],
    skillId: string,
    tags: string[],
  ): void {
    tx.delete(skillTags).where(eq(skillTags.skillId, skillId)).run();
    const unique = Array.from(new Set(tags.filter(t => t && t.length > 0)));
    if (unique.length === 0) return;
    tx.insert(skillTags).values(unique.map(tag => ({ skillId, tag }))).run();
  }

  private toEntity(row: typeof skills.$inferSelect, tags: string[]): SkillMeta {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      displayName: row.displayName,
      description: row.description,
      version: row.version,
      category: row.category,
      tags,
      attributes: parseAttributes(row.attributes, row.id),
      retrievalMeta: parseRetrievalMeta(row.retrievalMeta, row.id),
      status: row.status as SkillStatus,
      visibility: row.visibility as SkillMeta["visibility"],
      entryFile: row.entryFile ?? "SKILL.md",
      storagePath: row.storagePath,
      contentHash: row.contentHash,
      importSource: row.importSource ?? null,
      importUrl: row.importUrl ?? null,
      importBranch: row.importBranch ?? null,
      importSubDir: row.importSubDir ?? null,
      importedAt: row.importedAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

export function bumpVersion(current: string, bump: VersionBump = "patch"): string {
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return "0.0.1";
  switch (bump) {
    case "major": return `${parts[0] + 1}.0.0`;
    case "minor": return `${parts[0]}.${parts[1] + 1}.0`;
    case "patch": return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
}
