PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_access_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`skill_slug` text NOT NULL,
	`action` text NOT NULL,
	`file_paths` text,
	`latency_ms` integer,
	`user_id` text,
	`session_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_access_logs`("id", "skill_id", "skill_slug", "action", "file_paths", "latency_ms", "user_id", "session_id", "created_at") SELECT "id", "skill_id", "skill_slug", "action", "file_paths", "latency_ms", "user_id", "session_id", "created_at" FROM `access_logs`;--> statement-breakpoint
DROP TABLE `access_logs`;--> statement-breakpoint
ALTER TABLE `__new_access_logs` RENAME TO `access_logs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_access_logs_created_at` ON `access_logs` (`created_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `idx_skills_slug`;