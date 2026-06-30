// ============================================================
// Skill MCP Server — Core Type Definitions
// ============================================================

/** Skill status lifecycle */
export type SkillStatus = "draft" | "published" | "deprecated" | "archived";

/** Skill visibility */
export type SkillVisibility = "public" | "private" | "internal";

/** Version bump type */
export type VersionBump = "major" | "minor" | "patch";

/** File encoding */
export type FileEncoding = "utf-8" | "base64";

/**
 * P1-11 — retrieval-signal envelope persisted on the skill row. Extended in
 * stage 3 with embedding metadata (vector hash, provider/model version);
 * keeping it under a single JSON column means stage 3 can add fields without
 * a follow-up migration.
 */
export interface SkillRetrievalMeta {
  triggers?: string[];
  whenToUse?: string;
  embeddingText?: string;
}

/**
 * P1-12 stage 1 — Skill eval case authored in SKILL.md frontmatter. Stage 1
 * only persists the contract (manifest validation + lint nudge); stage 2
 * adds DB persistence + runner; stage 3 wires version-transition gating.
 *
 * At least one of `expectedTools` / `expectedOutputContains` /
 * `expectedOutputNotContains` MUST be present — a case with zero
 * expectations cannot fail the regression and is therefore ignored.
 */
export interface SkillEvalCase {
  /** Stable identifier for the case, unique within a skill. 1..128 chars. */
  name: string;
  /** Natural-language input the agent receives when running the case. 1..4096 chars. */
  input: string;
  /**
   * Tool names the agent is expected to call (in any order). EVERY entry
   * must appear in the run's tool list. Empty / omitted skips this assertion.
   */
  expectedTools?: string[];
  /**
   * Output substrings the run must contain — EVERY entry must appear.
   * Empty / omitted skips this assertion.
   */
  expectedOutputContains?: string[];
  /**
   * Output substrings the run must NOT contain — NO entry may appear.
   * Empty / omitted skips this assertion.
   */
  expectedOutputNotContains?: string[];
}

/** Skill metadata (DB entity) */
export interface SkillMeta {
  id: string;
  slug: string;
  name: string;
  displayName: string | null;
  description: string;
  version: string;
  category: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  retrievalMeta: SkillRetrievalMeta | null;
  status: SkillStatus;
  visibility: SkillVisibility;
  entryFile: string;
  storagePath: string;
  contentHash: string | null;
  // Import source tracking
  importSource: string | null;  // "local" | "git"
  importUrl: string | null;     // Git repository URL
  importBranch: string | null;  // Git branch
  importSubDir: string | null;  // Sub-directory within repo
  importedAt: number | null;    // Timestamp of last import
  createdAt: number;
  updatedAt: number;
}

/** Skill metadata input (for create/update) */
export type SkillMetaInput = Partial<Omit<SkillMeta, "id" | "createdAt" | "updatedAt">> &
  Pick<SkillMeta, "slug" | "name">;

/**
 * Public-facing skill metadata returned to MCP clients / HTTP callers.
 * Internal storage details (`storagePath`, `contentHash`, `storageBackend`)
 * are stripped — they leak filesystem layout and enable path probing.
 */
export type SkillMetaPublic = Omit<SkillMeta, "storagePath" | "contentHash">;

/** Strip internal storage fields before returning a skill to a client. */
export function toSkillMetaPublic(skill: SkillMeta): SkillMetaPublic {
  const { storagePath: _storagePath, contentHash: _contentHash, ...publicMeta } = skill;
  void _storagePath;
  void _contentHash;
  return publicMeta;
}

/** File info in skill file tree */
export interface FileInfo {
  path: string;
  type: "file" | "directory";
  size: number;
  mimeType: string;
}

/** Skill file content */
export interface SkillFileContent {
  path: string;
  content: string;
  encoding: FileEncoding;
  mimeType?: string;
}

/** Skill package file input (for import) */
export interface SkillFileInput {
  path: string;
  buffer: Buffer;
}

/** Skill metadata parsed from SKILL.md frontmatter */
export interface SkillFrontmatter {
  name: string;
  version?: string;
  description?: string;
  entry?: string;
  files?: string[];
  tags?: string[];
  category?: string;
  /**
   * P1-21 — Manifest schema version (`major.minor`). Missing means legacy
   * "0.x" content; the validator coerces it to {@link CURRENT_MANIFEST_SCHEMA}
   * with a deprecation warning. Values are validated against
   * {@link MAX_SUPPORTED_MANIFEST_MAJOR} so future major bumps surface a
   * clear "server too old" error instead of silently accepting unknown shapes.
   */
  manifestSchema?: string;
  /**
   * P1-11 — retrieval signal: short trigger phrases that should match this
   * skill in `skill_search`. Each entry is treated as a keyword for BM25 and
   * concatenated into the embedding input when {@link embeddingText} is absent.
   */
  triggers?: string[];
  /**
   * P1-11 — natural-language "when to use" hint surfaced to the agent at
   * ranking time. Distinct from {@link description} (which is end-user copy)
   * — intended to be model-readable.
   */
  whenToUse?: string;
  /**
   * P1-11 — explicit embedding source text. When absent the retrieval layer
   * falls back to `${name} ${description ?? ""} ${whenToUse ?? ""} ${triggers.join(" ")}`.
   * Use this when the natural metadata is too short or noisy.
   */
  embeddingText?: string;
  /**
   * P1-12 stage 1 — eval cases authored alongside the skill. Stage 1 only
   * validates + persists the contract; stages 2/3 add the runner and
   * version-transition regression gate.
   */
  evalCases?: SkillEvalCase[];
}

/** Import options */
export interface ImportOptions {
  category?: string;
  tags?: string[];
  description?: string;
  targetId?: string;
  versionBump?: VersionBump;
  overwrite?: boolean;
  allowDuplicate?: boolean;
  slug?: string;
  branch?: string;
  subDir?: string;
}

/** Import result */
export interface ImportResult {
  id: string;
  slug: string;
  name: string;
  version: string;
  fileCount: number;
  category?: string;
  tags?: string[];
  action: "created" | "updated";
}

/** Access log entry */
export interface AccessLogEntry {
  id: string;
  skillId: string;
  skillSlug: string;
  action: "list" | "view_entry" | "read_files";
  filePaths?: string[];
  latencyMs?: number;
  userId?: string;
  sessionId?: string;
  createdAt: number;
}

/** Transport type */
export type TransportType = "stdio" | "sse" | "http";

/** Deployment mode */
export type DeploymentMode = "standalone" | "gateway" | "cloud";

/** Storage type */
export type StorageType = "local-fs" | "aliyun-oss";

/** Default tenant id used by single-tenant deployments and as the
 *  backfill for legacy data without an explicit tenant. The value also
 *  matches `DEFAULT 'default'` on every `tenant_id` column. */
export const DEFAULT_TENANT_ID = "default";

/** Request context for permission and session tracking */
export interface RequestContext {
  /** P0-3 — tenant boundary. Defaults to {@link DEFAULT_TENANT_ID} for
   *  single-tenant / anonymous callers; the user table will eventually
   *  carry a `tenant_id` column that the context builder reads. */
  tenantId: string;
  userId: string;
  sessionId: string;
  tags: Set<string>;
  isAuthenticated: boolean;
  /** User type for permission checks (admin route access, superadmin guards). */
  userType?: "superadmin" | "admin" | "user";
}

/** Skill feedback entry */
export interface SkillFeedbackEntry {
  id: string;
  skillId: string;
  skillSlug: string;
  userId: string | null;
  sessionId: string | null;
  outcome: "success" | "partial" | "failure" | "irrelevant";
  context: string | null;
  agentComment: string | null;
  createdAt: number;
}

/** Skill version entry */
export interface SkillVersionEntry {
  id: string;
  skillId: string;
  version: string;
  contentHash: string;
  storagePath: string;
  entryFile: string;
  fileCount: number;
  createdBy: string | null;
  changeSummary: string | null;
  createdAt: number;
}
