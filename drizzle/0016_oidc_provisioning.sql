-- P1-14 stage 3 — OIDC user auto-provisioning + group→role mapping.
--
-- Stage 2 (already shipped) verifies a JWT and synthesizes a transient
-- userId of the form `oidc:<issuer>:<subject>`. Those identities never hit
-- the `users` table, so they have no role assignments, no audit trail, and
-- no admin handle for revocation. Stage 3 closes the gap:
--
--   1. `oidc_identities` is the join table from `(issuer, subject)` to a
--      real `users.id`. First time we see a verified JWT for a subject, we
--      create both rows in a single transaction and remember the link here.
--   2. `oidc_group_role_map` lets an operator declare "any subject whose
--      JWT carries group X is a member of role Y" without provisioning
--      every user by hand. The provisioner reads this on first sight and
--      seeds `user_roles` accordingly.
--
-- Schema choices:
--   * `oidc_identities` keys on `(issuer, subject)` rather than
--      `(tenant_id, issuer, subject)` because a subject is globally
--      meaningful within an issuer — multi-tenant deployments share an
--      IdP and we want the same human to map to one user row regardless
--      of which tenant first surfaced them. `tenant_id` is recorded for
--      filtering / audit but is not part of the uniqueness contract.
--   * `oidc_group_role_map` is per-tenant because tenants run independent
--      RBAC catalogs — `tenant-a:engineering` and `tenant-b:engineering`
--      might map to different roles. The UNIQUE on `(tenant_id, group_name,
--      role_id)` prevents accidental double-mappings; multiple roles per
--      group is intentional (one group can grant N roles).
--   * `last_seen_at` on `oidc_identities` is updated on every successful
--      verify so admins can spot dormant SSO accounts. Updates are
--      best-effort — losing one is harmless.
CREATE TABLE `oidc_identities` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text DEFAULT 'default' NOT NULL,
  `issuer` text NOT NULL,
  `subject` text NOT NULL,
  `user_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `last_seen_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uk_oidc_identities_issuer_subject` ON `oidc_identities` (`issuer`, `subject`);
--> statement-breakpoint
CREATE INDEX `idx_oidc_identities_user_id` ON `oidc_identities` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_oidc_identities_tenant_id` ON `oidc_identities` (`tenant_id`);
--> statement-breakpoint
CREATE TABLE `oidc_group_role_map` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text DEFAULT 'default' NOT NULL,
  `group_name` text NOT NULL,
  `role_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uk_oidc_group_role_map_tenant_group_role` ON `oidc_group_role_map` (`tenant_id`, `group_name`, `role_id`);
--> statement-breakpoint
CREATE INDEX `idx_oidc_group_role_map_tenant_group` ON `oidc_group_role_map` (`tenant_id`, `group_name`);
