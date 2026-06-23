-- User type and login support
-- Adds username, password_hash, and user_type columns to the users table.
-- Clears existing users and user_roles for a clean start.

DELETE FROM user_roles;
--> statement-breakpoint
DELETE FROM users;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN username TEXT;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN password_hash TEXT;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN user_type TEXT NOT NULL DEFAULT 'user';
--> statement-breakpoint
CREATE UNIQUE INDEX idx_users_username ON users(username) WHERE username IS NOT NULL;
