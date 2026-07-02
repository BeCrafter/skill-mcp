import { sqliteTable, text, integer, blob, index, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core";

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  displayName: text("display_name"),
  description: text("description").notNull().default(""),
  version: text("version").notNull().default("0.0.1"),
  category: text("category"),
  attributes: text("attributes"), // JSON object
  retrievalMeta: text("retrieval_meta"),
  status: text("status").notNull().default("draft"),
  visibility: text("visibility").notNull().default("private"),
  entryFile: text("entry_file").default("SKILL.md"),
  storagePath: text("storage_path").notNull(),
  contentHash: text("content_hash"),
  // Import source tracking for sync-upgrade support
  importSource: text("import_source"), // "local" | "git"
  importUrl: text("import_url"),       // Git repository URL
  importBranch: text("import_branch"), // Git branch (default: main)
  importSubDir: text("import_sub_dir"), // Sub-directory within repo
  importedAt: integer("imported_at"),  // Timestamp of last import
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("idx_skills_name").on(table.name),
  index("idx_skills_status").on(table.status),
  index("idx_skills_visibility").on(table.visibility),
  uniqueIndex("unique_name_content_hash").on(table.name, table.contentHash),
]);

export const skillTags = sqliteTable("skill_tags", {
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  tag: text("tag").notNull(),
}, (table) => [
  primaryKey({ columns: [table.skillId, table.tag] }),
  index("idx_skill_tags_tag").on(table.tag),
]);

export const skillFiles = sqliteTable("skill_files", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  fileType: text("file_type").notNull(),
  fileSize: integer("file_size").notNull(),
  mimeType: text("mime_type").notNull().default("application/octet-stream"),
  checksum: text("checksum"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_skill_files_skill_id").on(table.skillId),
]);

export const accessLogs = sqliteTable("access_logs", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  skillSlug: text("skill_slug").notNull(),
  action: text("action").notNull(),
  filePaths: text("file_paths"), // JSON
  latencyMs: integer("latency_ms"),
  userId: text("user_id"),
  sessionId: text("session_id"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_access_logs_created_at").on(table.createdAt),
]);

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  username: text("username"),
  passwordHash: text("password_hash"),
  userType: text("user_type").notNull().default("user"),
  token: text("token").notNull().unique(),
  // Stores the plaintext token for display on `user get`. Only populated
  // when the token is created or rotated; callers must have admin+ privileges.
  tokenPlaintext: text("token_plaintext"),
  status: text("status").default("active"),
  // P0-4 — token expiration. NULL means "never expires" so existing rows
  // continue to work without migration coordination. Tokens minted via
  // `skill-mcp user create --ttl=<duration>` (or the `expires_in` REST field)
  // populate this with `now + ttl` epoch ms.
  tokenExpiresAt: integer("token_expires_at"),
  // P0-4 — dual-token grace window for rotation. When an admin rotates a
  // user's token via POST /api/v1/admin/users/:id/rotate-token, the previous
  // sha256(token) hash is moved into previousToken with previousTokenExpiresAt
  // set to `now + 7d`. Auth accepts either slot until that grace expires;
  // afterwards only the new token works. Set to NULL when no rotation is in
  // flight.
  previousToken: text("previous_token"),
  previousTokenExpiresAt: integer("previous_token_expires_at"),
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
}, (table) => [
  index("idx_users_token").on(table.token),
  index("idx_users_previous_token").on(table.previousToken),
  uniqueIndex("idx_users_username").on(table.username),
]);

export const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  tags: text("tags").notNull(),
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
});

export const userRoles = sqliteTable("user_roles", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  createdAt: integer("created_at"),
}, (table) => [
  // T-602 — uk_user_roles_user_role doubles as the per-user lookup index;
  // the standalone idx_user_roles_user_id was dropped in 0005.
  uniqueIndex("uk_user_roles_user_role").on(table.userId, table.roleId),
  index("idx_user_roles_role_id").on(table.roleId),
]);

export const skillFeedbacks = sqliteTable("skill_feedbacks", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  skillSlug: text("skill_slug").notNull(),
  userId: text("user_id"),
  sessionId: text("session_id"),
  outcome: text("outcome").notNull(),
  context: text("context"),
  agentComment: text("agent_comment"),
  version: text("version"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_feedbacks_skill_slug").on(table.skillSlug),
  index("idx_feedbacks_created_at").on(table.createdAt),
  index("idx_feedbacks_outcome").on(table.outcome),
]);

export const skillVersions = sqliteTable("skill_versions", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  contentHash: text("content_hash").notNull(),
  storagePath: text("storage_path").notNull(),
  entryFile: text("entry_file").default("SKILL.md"),
  fileCount: integer("file_count").notNull().default(0),
  createdBy: text("created_by"),
  changeSummary: text("change_summary"),
  isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_skill_versions_skill_id").on(table.skillId),
  index("idx_skill_versions_version").on(table.skillId, table.version),
  index("idx_skill_versions_created_at").on(table.createdAt),
]);

// P0-10 — async import jobs. The sync POST /api/v1/admin/skills path holds
// the request for the entire staging-commit cycle, which is fine for small
// payloads but becomes unusable for large git imports (commercialization
// review §17.2 lists 50MB ≤ 30s). The async route enqueues a row here and
// hands the request to the BackgroundImportWorker; clients poll
// GET /api/v1/admin/jobs/:jobId for progress + final result.
//
// Persisted (rather than in-memory) so progress survives restart: on boot,
// any rows left in `running` are reset to `queued` so the worker can pick
// them back up. Failed rows are kept for audit (`error` carries the message).
export const importJobs = sqliteTable("import_jobs", {
  id: text("id").primaryKey(),
  status: text("status", { enum: ["queued", "running", "succeeded", "failed"] }).notNull().default("queued"),
  source: text("source").notNull(),
  optionsJson: text("options_json").notNull().default("{}"),
  progress: integer("progress").notNull().default(0),
  message: text("message"),
  resultJson: text("result_json"),
  errorMessage: text("error_message"),
  createdByUserId: text("created_by_user_id"),
  createdAt: integer("created_at").notNull(),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
}, (table) => [
  index("idx_import_jobs_status").on(table.status),
  index("idx_import_jobs_created_at").on(table.createdAt),
]);

// Cache epochs (P0-B). Monotonic version counters used to invalidate L1/L2
// caches in O(1). `cache_global_epoch` holds a single row keyed by id="global"
// (one bump fans out to every user). `cache_user_epochs` holds per-user
// counters bumped when only that user's accessible skill set changed.
//
// Persistence rationale: the in-memory `CacheEpochManager` resets to 0 on
// restart, but L2 (file) cache entries may carry the previous run's
// `g{N}:u{M}` suffix. Without persistence, after a restart the new key
// suffix `g0:u0` will collide with the *old* `g0:u0` key, serving stale
// data until TTL. Persisting the counter and reloading on boot prevents
// that. The simple two-row write-through does NOT need to be transactional
// with the cache invalidation itself — a lost bump is a stale read at
// worst, which the old design already accepted.
export const cacheGlobalEpoch = sqliteTable("cache_global_epoch", {
  id: text("id").primaryKey(),
  epoch: integer("epoch").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const cacheUserEpochs = sqliteTable("cache_user_epochs", {
  userId: text("user_id").primaryKey(),
  epoch: integer("epoch").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

// P1-13 — Usage metering events (review §9.1). Distinct from `access_logs`
// (operational audit, short retention) — this table is the billing-grade source
// of truth, with `quantity` carrying byte counts / token counts rather than the
// "this happened once" semantics of access logs. `hour_bucket` is pre-computed
// UTC ("YYYY-MM-DDTHH") so aggregation queries can hit a covering index.
//
// Write path is fire-and-forget through `UsageMeterService`: failures log a
// warn and bump a metric but never block the request. The hot-path overhead
// is one INSERT per metered call (a few hundred microseconds at SQLite's
// WAL mode); for higher volumes, batch via Redis counters and archive hourly.
export const usageEvents = sqliteTable("usage_events", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  eventType: text("event_type").notNull(),
  resourceId: text("resource_id"),
  quantity: integer("quantity").notNull().default(1),
  metadata: text("metadata"), // JSON
  hourBucket: text("hour_bucket").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_usage_events_bucket").on(table.hourBucket),
  index("idx_usage_events_event").on(table.eventType, table.hourBucket),
  index("idx_usage_events_created_at").on(table.createdAt),
]);

// Pipeline runs (T-203). Persists two-phase pipeline state across process
// restarts so a long-running pipeline can be resumed by clients. Definition,
// inputs, batches, and completed stage outputs are JSON blobs because the
// shape varies per pipeline; we rebuild ExecutionContext / DAGScheduler at
// hydrate time from these snapshots.
export const pipelineRuns = sqliteTable("pipeline_runs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status", { enum: ["running", "completed", "failed"] }).notNull(),
  definitionJson: text("definition_json").notNull(),
  inputsJson: text("inputs_json").notNull(),
  batchesJson: text("batches_json").notNull(),
  completedStagesJson: text("completed_stages_json").notNull().default("{}"),
  currentBatchIndex: integer("current_batch_index").notNull().default(0),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
}, (table) => [
  index("idx_pipeline_runs_status").on(table.status),
  index("idx_pipeline_runs_started_at").on(table.startedAt),
]);


// P1-16 — Webhook outbound subscriptions (review §5.5.1). One row per
// webhook subscription customers register; matching domain events fan
// out into `webhook_deliveries`. `secret` is shown once via the admin POST
// response (returned alongside the row), then never reflected back on
// list/get — the create handler hides it from `webhookToJson`. `event_types`
// is JSON array of canonical event names (`skill.published`, `pipeline.completed`,
// `skill.deprecated`, `user.token_rotated`).
export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  eventTypes: text("event_types").notNull(),
  enabled: integer("enabled").notNull().default(1),
  description: text("description"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  secretRotatedAt: integer("secret_rotated_at"),
}, (table) => [
  index("idx_webhooks_enabled").on(table.enabled),
]);

// P1-16 — Webhook delivery ledger and retry queue (review §5.5.1). The same
// row is updated through up to 8 attempts; the same `delivery_id` UUID is
// echoed in the `X-Skill-MCP-Delivery-Id` header so client idempotency keys
// stay stable across retries. After attempt 8, status flips to `dead_letter`
// and `next_retry_at` is cleared (admin replay sets it back to `pending`).
export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull(),
  eventType: text("event_type").notNull(),
  deliveryId: text("delivery_id").notNull(),
  payload: text("payload").notNull(),
  attempt: integer("attempt").notNull().default(0),
  status: text("status", { enum: ["pending", "success", "failed", "dead_letter"] }).notNull().default("pending"),
  responseStatus: integer("response_status"),
  responseBody: text("response_body"),
  errorMessage: text("error_message"),
  nextRetryAt: integer("next_retry_at"),
  firstAttemptedAt: integer("first_attempted_at"),
  lastAttemptedAt: integer("last_attempted_at"),
  completedAt: integer("completed_at"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_webhook_deliveries_delivery_id").on(table.deliveryId),
  index("idx_webhook_deliveries_due").on(table.status, table.nextRetryAt),
  index("idx_webhook_deliveries_webhook").on(table.webhookId, table.createdAt),
]);

// P1-12 stage 2 — Skill eval cases (review §3 项 12). One row per (skill_id,
// case_name); `expectations_json` is a JSON envelope of optional expectation
// arrays so future expectation kinds (e.g. `expected_latency_ms`,
// `expected_score_min`) ship without a migration. Same shape stored on disk
// in SKILL.md frontmatter (`eval_cases:`) — the importer persists the
// validated stage-1 view straight into this table.
//
// Why a separate table (not JSON on `skills`):
//   1. Stage 3's regression gate joins runs back to (skill, version, case)
//      — that requires a row-per-case identity, which JSON arrays don't give.
//   2. Imports may have many cases (cap 32) and the row gets read mostly
//      during eval runs, not during the hot skill-fetch path.
//   3. Letting cases live as their own rows means the runner can iterate
//      with `WHERE skill_id = ?` without parsing JSON envelopes per request.
export const skillEvalCases = sqliteTable("skill_eval_cases", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  caseName: text("case_name").notNull(),
  input: text("input").notNull(),
  // JSON: { expectedOutputContains?: string[]; expectedOutputNotContains?: string[] }
  expectationsJson: text("expectations_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  // Stage 1 already enforces case-name uniqueness within a skill at validate
  // time, but the DB UNIQUE provides a defense-in-depth + supports stage 3's
  // upsert-on-reimport path.
  uniqueIndex("uk_skill_eval_cases_skill_case").on(table.skillId, table.caseName),
  index("idx_skill_eval_cases_skill_id").on(table.skillId),
]);

// P1-12 stage 2 — Skill eval run log. Append-only audit trail of every
// runner invocation. One row per (case × run); the index on (skill_id,
// skill_version) is what stage 3's regression gate uses to ask "have all
// cases for skill X version Y passed at least once?".
//
// `runner` distinguishes the stub echo provider (stage 2) from real LLM
// providers (stage 3+) without changing the schema; failed runs keep the
// failure_reason text for the runner CLI to display in red without
// reparsing output.
export const skillEvalRuns = sqliteTable("skill_eval_runs", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  skillVersion: text("skill_version").notNull(),
  caseName: text("case_name").notNull(),
  status: text("status", { enum: ["pass", "fail", "error"] }).notNull(),
  runner: text("runner").notNull().default("stub"),
  toolsUsedJson: text("tools_used_json"),
  output: text("output"),
  failureReason: text("failure_reason"),
  latencyMs: integer("latency_ms"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_skill_eval_runs_skill_version").on(table.skillId, table.skillVersion),
  index("idx_skill_eval_runs_created_at").on(table.createdAt),
]);

// P1-11 stage 3 — Embedding sidecar. One row per skill (PK = skill_id).
// `vector` stores the raw Float32Array bytes via Buffer; the repository
// translates to/from Float32Array on read/write so consumers never see the
// raw blob. `model_name` lets the search service detect rows written by a
// previous embedding model (dimension change → wholesale re-embed) and
// `content_hash` lets it skip re-embedding when the SKILL.md content
// didn't change but some other unrelated field did. See drizzle/0014.
export const skillEmbeddings = sqliteTable("skill_embeddings", {
  skillId: text("skill_id").primaryKey().references(() => skills.id, { onDelete: "cascade" }),
  modelName: text("model_name").notNull(),
  dimension: integer("dimension").notNull(),
  vector: blob("vector").notNull(),
  contentHash: text("content_hash"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("idx_skill_embeddings_model").on(table.modelName),
]);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  operatorId: text("operator_id"),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_audit_logs_entity").on(table.entityType, table.entityId),
  index("idx_audit_logs_created").on(table.createdAt),
]);
