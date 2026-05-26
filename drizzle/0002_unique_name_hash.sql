-- T-202: idempotency — concurrent imports of the same (name, content_hash)
-- payload should collapse onto the same row instead of UNIQUE-failing on
-- slug. Implemented as a partial unique index so historical rows with NULL
-- content_hash don't collide with each other.
CREATE UNIQUE INDEX `unique_name_content_hash` ON `skills` (`name`, `content_hash`) WHERE `content_hash` IS NOT NULL;
