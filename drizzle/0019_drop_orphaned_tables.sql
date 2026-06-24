-- Drop orphaned P1-14 stage 3 tables (never had repositories or code) and
-- OIDC tables (created by 0016, absent from Drizzle schema).
DROP TABLE IF EXISTS sessions;
--> statement-breakpoint
DROP TABLE IF EXISTS delegation_rules;
--> statement-breakpoint
DROP TABLE IF EXISTS service_accounts;
--> statement-breakpoint
DROP TABLE IF EXISTS group_members;
--> statement-breakpoint
DROP TABLE IF EXISTS groups;
--> statement-breakpoint
DROP TABLE IF EXISTS oidc_group_role_map;
--> statement-breakpoint
DROP TABLE IF EXISTS oidc_identities;
