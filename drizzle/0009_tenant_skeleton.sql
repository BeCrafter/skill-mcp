-- P0-3 — multi-tenant skeleton (review §2.1).
-- Adds the `tenants` table and a `tenant_id` column on every table that holds
-- per-organization data. The default tenant 'default' is seeded so existing
-- single-tenant deployments continue to work unchanged: every existing row
-- backfills to tenant 'default', and every new row inserted without an
-- explicit `tenant_id` falls through to the column DEFAULT.
--
-- This migration is intentionally additive only — no PK changes, no index
-- drops, no data moves. Storage path migration ({tenantId}/{slug}/) and the
-- composite-key cache epoch tables are deferred to a follow-up because they
-- require physical data moves; this migration unblocks the type / DTO /
-- request-context plumbing without touching live storage.
CREATE TABLE `tenants` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `status` text NOT NULL DEFAULT 'active',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `tenants` (`id`, `name`, `description`, `status`, `created_at`, `updated_at`)
  VALUES ('default', 'Default Tenant', 'Auto-seeded for single-tenant deployments', 'active',
          (strftime('%s','now') * 1000), (strftime('%s','now') * 1000));
--> statement-breakpoint
ALTER TABLE `skills` ADD COLUMN `tenant_id` text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE `skill_files` ADD COLUMN `tenant_id` text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE `access_logs` ADD COLUMN `tenant_id` text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `tenant_id` text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE `roles` ADD COLUMN `tenant_id` text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE `user_roles` ADD COLUMN `tenant_id` text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE `skill_feedbacks` ADD COLUMN `tenant_id` text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE `skill_versions` ADD COLUMN `tenant_id` text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE `import_jobs` ADD COLUMN `tenant_id` text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE `pipeline_runs` ADD COLUMN `tenant_id` text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE `cache_global_epoch` ADD COLUMN `tenant_id` text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE `cache_user_epochs` ADD COLUMN `tenant_id` text NOT NULL DEFAULT 'default';
--> statement-breakpoint
CREATE INDEX `idx_skills_tenant_id` ON `skills`(`tenant_id`);
--> statement-breakpoint
CREATE INDEX `idx_access_logs_tenant_id` ON `access_logs`(`tenant_id`);
--> statement-breakpoint
CREATE INDEX `idx_users_tenant_id` ON `users`(`tenant_id`);
--> statement-breakpoint
CREATE INDEX `idx_roles_tenant_id` ON `roles`(`tenant_id`);
