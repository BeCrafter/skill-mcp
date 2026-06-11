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
CREATE INDEX IF NOT EXISTS `idx_import_jobs_status` ON `import_jobs` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_import_jobs_created_at` ON `import_jobs` (`created_at`);
