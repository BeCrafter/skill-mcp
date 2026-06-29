-- Adds is_current column to skill_versions for marking the current version.
ALTER TABLE `skill_versions` ADD COLUMN `is_current` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Adds audit_logs table for tracking changes
CREATE TABLE IF NOT EXISTS `audit_logs` (
    `id` text PRIMARY KEY NOT NULL,
    `action` text NOT NULL,
    `entity_type` text NOT NULL,
    `entity_id` text NOT NULL,
    `operator_id` text,
    `before_json` text,
    `after_json` text,
    `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_logs_entity` ON `audit_logs` (`entity_type`,`entity_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_logs_created` ON `audit_logs` (`created_at`);
