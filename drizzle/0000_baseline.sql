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
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_access_logs_created_at` ON `access_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
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
CREATE INDEX `idx_audit_logs_entity` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_created` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `cache_global_epoch` (
	`id` text PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cache_user_epochs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`source` text NOT NULL,
	`options_json` text DEFAULT '{}' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`message` text,
	`result_json` text,
	`error_message` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_import_jobs_status` ON `import_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_import_jobs_created_at` ON `import_jobs` (`created_at`);--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`definition_json` text NOT NULL,
	`inputs_json` text NOT NULL,
	`batches_json` text NOT NULL,
	`completed_stages_json` text DEFAULT '{}' NOT NULL,
	`current_batch_index` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_runs_status` ON `pipeline_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_runs_started_at` ON `pipeline_runs` (`started_at`);--> statement-breakpoint
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
CREATE TABLE `skill_embeddings` (
	`skill_id` text PRIMARY KEY NOT NULL,
	`model_name` text NOT NULL,
	`dimension` integer NOT NULL,
	`vector` blob NOT NULL,
	`content_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_skill_embeddings_model` ON `skill_embeddings` (`model_name`);--> statement-breakpoint
CREATE TABLE `skill_eval_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`case_name` text NOT NULL,
	`input` text NOT NULL,
	`expectations_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uk_skill_eval_cases_skill_case` ON `skill_eval_cases` (`skill_id`,`case_name`);--> statement-breakpoint
CREATE INDEX `idx_skill_eval_cases_skill_id` ON `skill_eval_cases` (`skill_id`);--> statement-breakpoint
CREATE TABLE `skill_eval_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`skill_version` text NOT NULL,
	`case_name` text NOT NULL,
	`status` text NOT NULL,
	`runner` text DEFAULT 'stub' NOT NULL,
	`tools_used_json` text,
	`output` text,
	`failure_reason` text,
	`latency_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_skill_eval_runs_skill_version` ON `skill_eval_runs` (`skill_id`,`skill_version`);--> statement-breakpoint
CREATE INDEX `idx_skill_eval_runs_created_at` ON `skill_eval_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `skill_feedbacks` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`skill_slug` text NOT NULL,
	`user_id` text,
	`session_id` text,
	`outcome` text NOT NULL,
	`context` text,
	`agent_comment` text,
	`version` text,
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
	`is_current` integer DEFAULT false NOT NULL,
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
	`retrieval_meta` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`entry_file` text DEFAULT 'SKILL.md',
	`storage_path` text NOT NULL,
	`content_hash` text,
	`import_source` text,
	`import_url` text,
	`import_branch` text,
	`import_sub_dir` text,
	`imported_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_slug_unique` ON `skills` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_skills_name` ON `skills` (`name`);--> statement-breakpoint
CREATE INDEX `idx_skills_status` ON `skills` (`status`);--> statement-breakpoint
CREATE INDEX `idx_skills_visibility` ON `skills` (`visibility`);--> statement-breakpoint
CREATE UNIQUE INDEX `unique_name_content_hash` ON `skills` (`name`,`content_hash`);--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`event_type` text NOT NULL,
	`resource_id` text,
	`quantity` integer DEFAULT 1 NOT NULL,
	`metadata` text,
	`hour_bucket` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_usage_events_bucket` ON `usage_events` (`hour_bucket`);--> statement-breakpoint
CREATE INDEX `idx_usage_events_event` ON `usage_events` (`event_type`,`hour_bucket`);--> statement-breakpoint
CREATE INDEX `idx_usage_events_created_at` ON `usage_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uk_user_roles_user_role` ON `user_roles` (`user_id`,`role_id`);--> statement-breakpoint
CREATE INDEX `idx_user_roles_role_id` ON `user_roles` (`role_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`username` text,
	`password_hash` text,
	`user_type` text DEFAULT 'user' NOT NULL,
	`token` text NOT NULL,
	`token_plaintext` text,
	`status` text DEFAULT 'active',
	`token_expires_at` integer,
	`previous_token` text,
	`previous_token_expires_at` integer,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_token_unique` ON `users` (`token`);--> statement-breakpoint
CREATE INDEX `idx_users_token` ON `users` (`token`);--> statement-breakpoint
CREATE INDEX `idx_users_previous_token` ON `users` (`previous_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_username` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event_type` text NOT NULL,
	`delivery_id` text NOT NULL,
	`payload` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`response_status` integer,
	`response_body` text,
	`error_message` text,
	`next_retry_at` integer,
	`first_attempted_at` integer,
	`last_attempted_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_webhook_deliveries_delivery_id` ON `webhook_deliveries` (`delivery_id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_due` ON `webhook_deliveries` (`status`,`next_retry_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_webhook` ON `webhook_deliveries` (`webhook_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`event_types` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`secret_rotated_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_webhooks_enabled` ON `webhooks` (`enabled`);