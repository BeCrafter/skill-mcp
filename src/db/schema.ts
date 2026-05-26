import { sqliteTable, text, integer, index, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core";

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  displayName: text("display_name"),
  description: text("description").notNull().default(""),
  version: text("version").notNull().default("0.0.1"),
  category: text("category"),
  attributes: text("attributes"), // JSON object
  status: text("status").notNull().default("draft"),
  visibility: text("visibility").notNull().default("private"),
  entryFile: text("entry_file").default("SKILL.md"),
  storagePath: text("storage_path").notNull(),
  contentHash: text("content_hash"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  // skills.slug already has a UNIQUE constraint, which SQLite implements as
  // a unique index — a separate non-unique idx_skills_slug would be a no-op
  // duplicate. Removed in migration 0001.
  index("idx_skills_name").on(table.name),
  index("idx_skills_status").on(table.status),
  index("idx_skills_visibility").on(table.visibility),
  // T-202: idempotency — a skill is identified by (name, content_hash). Two
  // concurrent imports of the same payload collapse onto the same row via
  // the UNIQUE conflict path (caught by the importer and translated to an
  // idempotent return). Implemented as a partial unique index in the
  // migration so existing rows with NULL content_hash don't collide.
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
  token: text("token").notNull().unique(),
  status: text("status").default("active"),
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
}, (table) => [
  index("idx_users_token").on(table.token),
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
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_skill_versions_skill_id").on(table.skillId),
  index("idx_skill_versions_version").on(table.skillId, table.version),
  index("idx_skill_versions_created_at").on(table.createdAt),
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
