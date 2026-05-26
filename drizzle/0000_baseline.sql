CREATE TABLE `access_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`skill_slug` text NOT NULL,
	`action` text NOT NULL,
	`file_paths` text,
	`latency_ms` integer,
	`user_id` text,
	`session_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_access_logs_created_at` ON `access_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`tags` text NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_name_unique` ON `roles` (`name`);--> statement-breakpoint
CREATE TABLE `skill_feedbacks` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`skill_slug` text NOT NULL,
	`user_id` text,
	`session_id` text,
	`outcome` text NOT NULL,
	`context` text,
	`agent_comment` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_feedbacks_skill_slug` ON `skill_feedbacks` (`skill_slug`);--> statement-breakpoint
CREATE INDEX `idx_feedbacks_created_at` ON `skill_feedbacks` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_feedbacks_outcome` ON `skill_feedbacks` (`outcome`);--> statement-breakpoint
CREATE TABLE `skill_files` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`file_path` text NOT NULL,
	`file_type` text NOT NULL,
	`file_size` integer NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`checksum` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_skill_files_skill_id` ON `skill_files` (`skill_id`);--> statement-breakpoint
CREATE TABLE `skill_tags` (
	`skill_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`skill_id`, `tag`),
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_skill_tags_tag` ON `skill_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`version` text NOT NULL,
	`content_hash` text NOT NULL,
	`storage_path` text NOT NULL,
	`entry_file` text DEFAULT 'SKILL.md',
	`file_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`change_summary` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_skill_versions_skill_id` ON `skill_versions` (`skill_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_versions_version` ON `skill_versions` (`skill_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_skill_versions_created_at` ON `skill_versions` (`created_at`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`display_name` text,
	`description` text DEFAULT '' NOT NULL,
	`version` text DEFAULT '0.0.1' NOT NULL,
	`category` text,
	`attributes` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`entry_file` text DEFAULT 'SKILL.md',
	`storage_path` text NOT NULL,
	`content_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_slug_unique` ON `skills` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_skills_slug` ON `skills` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_skills_name` ON `skills` (`name`);--> statement-breakpoint
CREATE INDEX `idx_skills_status` ON `skills` (`status`);--> statement-breakpoint
CREATE INDEX `idx_skills_visibility` ON `skills` (`visibility`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_roles_user_id` ON `user_roles` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`token` text NOT NULL,
	`status` text DEFAULT 'active',
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_token_unique` ON `users` (`token`);--> statement-breakpoint
CREATE INDEX `idx_users_token` ON `users` (`token`);