-- P1-13.5 — Tier limits + per-field overrides (review §9.1, §11 #13.5).
--
-- `tenant_quotas` carries the current (and historical) tier limits for each
-- tenant. The "current" row is identified by `effective_until IS NULL`;
-- when a tier changes, application code stamps the old row with `now` and
-- inserts a new row. This preserves history for billing reconciliation
-- without requiring point-in-time queries.
--
-- `tenant_quota_overrides` lets sales/support raise (or lower) a single
-- field for a tenant without rewriting the tier row. Overrides without
-- `expires_at` are permanent until removed; `reason` is mandatory text
-- (audit-grade — empty strings rejected by repository).
--
-- Default seeds (free / team / enterprise) are NOT inserted by this
-- migration; they are bootstrapped by `QuotaService.ensureDefaultsForTenant`
-- on first read so single-tenant deployments don't carry tier semantics
-- they don't use.
CREATE TABLE `tenant_quotas` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `tier` text NOT NULL,
  `max_users` integer NOT NULL,
  `max_skills` integer NOT NULL,
  `max_storage_bytes` integer NOT NULL,
  `max_api_calls_per_day` integer NOT NULL,
  `max_pipeline_runs_per_day` integer NOT NULL,
  `effective_from` integer NOT NULL,
  `effective_until` integer,
  `notes` text
);
--> statement-breakpoint
CREATE INDEX `idx_tenant_quotas_tenant` ON `tenant_quotas`(`tenant_id`, `effective_until`);
--> statement-breakpoint
CREATE TABLE `tenant_quota_overrides` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `field_name` text NOT NULL,
  `override_value` integer NOT NULL,
  `reason` text NOT NULL,
  `granted_by` text NOT NULL,
  `granted_at` integer NOT NULL,
  `expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_tenant_quota_overrides_lookup` ON `tenant_quota_overrides`(`tenant_id`, `field_name`, `expires_at`);
