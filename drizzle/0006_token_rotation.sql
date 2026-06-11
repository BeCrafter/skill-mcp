-- P0-4: token expiration + rotation grace window.
-- - token_expires_at: NULL = never expires (back-compat with pre-P0-4 tokens).
-- - previous_token + previous_token_expires_at: dual-token slot populated by
--   POST /api/v1/admin/users/:id/rotate-token. Auth accepts either slot until
--   the grace deadline (default now + 7d) expires; afterwards only `token` is
--   valid. Index on previous_token mirrors the existing one on token so the
--   secondary lookup stays O(log n).
ALTER TABLE `users` ADD COLUMN `token_expires_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `previous_token` text;--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `previous_token_expires_at` integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_previous_token` ON `users` (`previous_token`);
