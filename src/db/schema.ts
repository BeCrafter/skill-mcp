import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  displayName: text("display_name"),
  description: text("description").notNull().default(""),
  version: text("version").notNull().default("1.0.0"),
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
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_access_logs_created_at").on(table.createdAt),
]);
