import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  displayName: text("display_name"),
  description: text("description").notNull().default(""),
  version: text("version").notNull().default("0.0.1"),
  category: text("category"),
  tags: text("tags"), // JSON array
  attributes: text("attributes"), // JSON object
  status: text("status").notNull().default("draft"),
  visibility: text("visibility").notNull().default("public"),
  entryFile: text("entry_file").default("SKILL.md"),
  storagePath: text("storage_path").notNull(),
  contentHash: text("content_hash"),
  conditions: text("conditions"), // JSON
  assignedGroups: text("assigned_groups"), // JSON array
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("idx_skills_slug").on(table.slug),
  index("idx_skills_name").on(table.name),
  index("idx_skills_status").on(table.status),
  index("idx_skills_visibility").on(table.visibility),
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
  skillId: text("skill_id").notNull().references(() => skills.id),
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
  index("idx_user_roles_user_id").on(table.userId),
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
