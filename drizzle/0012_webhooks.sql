-- P1-16 — Webhook outbound (review §5.5.1).
--
-- `webhooks` carries the per-tenant subscription endpoint config. The HMAC
-- secret is stored as plaintext here for the SQLite default deployment
-- (review §7.1 calls out application-layer encryption as a P0 follow-up
-- which lands in a separate batch); creation flow returns the secret once
-- via the admin REST response and never re-exposes it on subsequent reads
-- (`overrideToJson` style — secret omitted from list/get responses).
--
-- `webhook_deliveries` is the durable retry queue + dead-letter ledger.
-- A single domain event produces one row per matching webhook with the
-- canonical `delivery_id` UUID; subsequent attempts UPDATE the same row
-- (incrementing `attempt`, replacing `next_retry_at` / `response_status`)
-- so clients keep a stable id for idempotency. `status="dead_letter"` is
-- terminal; admin replay flips it back to `status="pending"` with a fresh
-- `next_retry_at = now`.
--
-- Retry math (review §5.5.1): attempts 1..8, exp backoff
-- `min(2^n + jitter[0,1], 600)` seconds, total cap 24h. The worker polls
-- `idx_webhook_deliveries_due` for `status='pending' AND next_retry_at <= now`.
CREATE TABLE `webhooks` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `url` text NOT NULL,
  `secret` text NOT NULL,
  `event_types` text NOT NULL,
  `enabled` integer NOT NULL DEFAULT 1,
  `description` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `secret_rotated_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_webhooks_tenant` ON `webhooks`(`tenant_id`);
--> statement-breakpoint
CREATE INDEX `idx_webhooks_enabled` ON `webhooks`(`enabled`);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `webhook_id` text NOT NULL,
  `tenant_id` text NOT NULL,
  `event_type` text NOT NULL,
  `delivery_id` text NOT NULL,
  `payload` text NOT NULL,
  `attempt` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL DEFAULT 'pending',
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
CREATE UNIQUE INDEX `idx_webhook_deliveries_delivery_id` ON `webhook_deliveries`(`delivery_id`);
--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_due` ON `webhook_deliveries`(`status`, `next_retry_at`);
--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_tenant` ON `webhook_deliveries`(`tenant_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_webhook` ON `webhook_deliveries`(`webhook_id`, `created_at`);
