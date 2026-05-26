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
CREATE INDEX `idx_pipeline_runs_status` ON `pipeline_runs` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_runs_started_at` ON `pipeline_runs` (`started_at`);
