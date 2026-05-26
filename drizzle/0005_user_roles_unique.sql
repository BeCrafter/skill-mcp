-- T-602: user_roles needs a UNIQUE(user_id, role_id) constraint so the DB
-- itself rejects duplicate assignments. Step 1 dedupes any historical
-- duplicates (keeping the lowest id). Step 2 drops the old per-column
-- index that the new unique index makes redundant. Step 3 creates the
-- unique index that doubles as a per-user lookup.
DELETE FROM `user_roles` WHERE `id` NOT IN (SELECT MIN(`id`) FROM `user_roles` GROUP BY `user_id`, `role_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `idx_user_roles_user_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `uk_user_roles_user_role` ON `user_roles` (`user_id`, `role_id`);
