-- P1-13 — Usage metering data layer (review §9.1).
-- `usage_events` is the canonical source of truth for billing-grade metering.
-- Distinct from `access_logs` (which is operational audit, kept short retention)
-- in that:
--   • `quantity` is meaningful for storage-bytes / token-counts, not just
--     "this happened once"
--   • `hour_bucket` is the pre-computed UTC hour string ("YYYY-MM-DDTHH") so
--     aggregation queries hit a covering index instead of a date-cast scan
--   • `event_type` is unconstrained text rather than an enum so emerging
--     event types (e.g. "embedding.search") don't require a schema bump
--
-- Retention is deliberately **not** enforced at DB level — admin-driven
-- archival via `UsageEventRepository.deleteOlderThan(cutoff)` keeps recent
-- months hot for billing computation while older buckets are exported
-- to CSV/parquet by an external job.
CREATE TABLE `usage_events` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL DEFAULT 'default',
  `user_id` text,
  `event_type` text NOT NULL,
  `resource_id` text,
  `quantity` integer NOT NULL DEFAULT 1,
  `metadata` text,
  `hour_bucket` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_usage_events_tenant_bucket` ON `usage_events`(`tenant_id`, `hour_bucket`);
--> statement-breakpoint
CREATE INDEX `idx_usage_events_tenant_event` ON `usage_events`(`tenant_id`, `event_type`, `hour_bucket`);
--> statement-breakpoint
CREATE INDEX `idx_usage_events_created_at` ON `usage_events`(`created_at`);
