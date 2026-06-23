-- Permission architecture: add user_type, username, password_hash to users.
-- Clears existing user data (clean slate per design doc §14).
DELETE FROM user_roles;--> statement-breakpoint
DELETE FROM users;--> statement-breakpoint
ALTER TABLE users ADD COLUMN username TEXT;--> statement-breakpoint
ALTER TABLE users ADD COLUMN password_hash TEXT;--> statement-breakpoint
ALTER TABLE users ADD COLUMN user_type TEXT NOT NULL DEFAULT 'user';--> statement-breakpoint
CREATE UNIQUE INDEX idx_users_username ON users(username) WHERE username IS NOT NULL;
