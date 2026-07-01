DROP INDEX IF EXISTS `idx_skills_tenant_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_access_logs_tenant_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_users_tenant_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_roles_tenant_id`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `tenant_id`;
--> statement-breakpoint
ALTER TABLE `skill_files` DROP COLUMN `tenant_id`;
--> statement-breakpoint
ALTER TABLE `skill_versions` DROP COLUMN `tenant_id`;
--> statement-breakpoint
ALTER TABLE `access_logs` DROP COLUMN `tenant_id`;
--> statement-breakpoint
ALTER TABLE `skill_feedbacks` DROP COLUMN `tenant_id`;
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `tenant_id`;
--> statement-breakpoint
ALTER TABLE `roles` DROP COLUMN `tenant_id`;
--> statement-breakpoint
ALTER TABLE `user_roles` DROP COLUMN `tenant_id`;
--> statement-breakpoint
ALTER TABLE `import_jobs` DROP COLUMN `tenant_id`;
--> statement-breakpoint
ALTER TABLE `cache_global_epoch` DROP COLUMN `tenant_id`;
--> statement-breakpoint
ALTER TABLE `cache_user_epochs` DROP COLUMN `tenant_id`;
--> statement-breakpoint
ALTER TABLE `pipeline_runs` DROP COLUMN `tenant_id`;
--> statement-breakpoint
ALTER TABLE `skill_eval_cases` DROP COLUMN `tenant_id`;
--> statement-breakpoint
ALTER TABLE `skill_eval_runs` DROP COLUMN `tenant_id`;
