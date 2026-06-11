import { randomBytes, createHash } from "node:crypto";
import type { JwtPayload } from "./oidc-verifier.js";
import type { OidcIdentityRepository } from "../db/repositories/oidc-identity.repository.js";
import type { OidcGroupRoleMapRepository } from "../db/repositories/oidc-group-role-map.repository.js";
import type { UserRepository } from "../db/repositories/user.repository.js";
import type { UserRoleRepository } from "../db/repositories/user-role.repository.js";
import { withSpan } from "../telemetry/spans.js";

export interface OidcProvisionResult {
  /** The persistent `users.id` that this OIDC subject now resolves to. */
  userId: string;
  /** Tenant the user row belongs to. */
  tenantId: string;
  /** Tags aggregated from `user_roles` after group→role mapping was applied. */
  tags: string[];
  /** True if a new user row was created on this call. */
  isNewUser: boolean;
}

export interface OidcProvisionerConfig {
  identityRepo: OidcIdentityRepository;
  groupRoleMapRepo: OidcGroupRoleMapRepository;
  userRepo: UserRepository;
  userRoleRepo: UserRoleRepository;
  /** Default tenant for newly provisioned users. Falls back to "default". */
  defaultTenantId?: string;
  /** Optional logger; warn on auto-provision failures. */
  logger?: { warn: (obj: object, msg: string) => void; info?: (obj: object, msg: string) => void };
}

/**
 * P1-14 stage 3 — auto-provisioning service. First time a verified OIDC JWT
 * arrives, we create a `users` row keyed by `(issuer, subject)` and seed
 * `user_roles` from the `oidc_group_role_map` table. Subsequent calls just
 * touch `last_seen_at` and return the existing user.
 *
 * Why a placeholder token instead of leaving `users.token` empty: the column
 * is NOT NULL UNIQUE in the schema (legacy from opaque-token auth) and the
 * sha256 lookup path uses it as the cache key. Generating a high-entropy
 * sentinel (`oidc:<random>`) keeps the constraint satisfied without ever
 * matching a real bearer-token sha256 — the OIDC path resolves through this
 * service before the opaque-token path runs, so the sentinel is never read
 * back as a token. A future migration can drop the NOT NULL once all auth
 * paths route through here.
 */
export class OidcProvisioner {
  constructor(private readonly cfg: OidcProvisionerConfig) {}

  /**
   * Look up or create the persistent user for a verified JWT, then return the
   * tags aggregated from group→role mapping + existing user_roles.
   *
   * Idempotent: concurrent first-sight calls for the same subject collide on
   * the UNIQUE(issuer, subject) index in `oidc_identities`; the loser's INSERT
   * throws and we re-read to find the winner's user_id. The user row created
   * by the loser is harmless (orphaned with no identity row pointing at it),
   * but we minimize that risk by guarding the create path with an existence
   * re-check.
   */
  async provisionFromJwt(payload: JwtPayload, opts: { groupsClaim?: string; userClaim?: string } = {}): Promise<OidcProvisionResult | null> {
    return withSpan("auth.oidc_provision", { attributes: {} }, async () => {
      const userClaim = opts.userClaim ?? "sub";
      const groupsClaim = opts.groupsClaim ?? "groups";
      const subjectRaw = payload[userClaim];
      const issuerRaw = payload.iss;
      if (typeof subjectRaw !== "string" || !subjectRaw) return null;
      if (typeof issuerRaw !== "string" || !issuerRaw) return null;
      const subject = subjectRaw;
      const issuer = issuerRaw;

      const groups: string[] = [];
      const groupsClaimVal = payload[groupsClaim];
      if (Array.isArray(groupsClaimVal)) {
        for (const g of groupsClaimVal) {
          if (typeof g === "string" && g.trim()) groups.push(g.trim());
        }
      }

      const existing = await this.cfg.identityRepo.findByIssuerSubject(issuer, subject);
      let resolvedUserId: string;
      let resolvedTenantId: string;
      let isNewUser = false;
      if (!existing) {
        const created = await this.createUserAndIdentity(issuer, subject, groups);
        resolvedUserId = created.identity.userId;
        resolvedTenantId = created.identity.tenantId;
        isNewUser = created.isNewUser;
      } else {
        resolvedUserId = existing.userId;
        resolvedTenantId = existing.tenantId;
        // Best-effort lastSeen update. We swallow errors here because losing
        // an update is harmless and the auth path must not fail on it.
        try {
          await this.cfg.identityRepo.touchLastSeen(existing.id);
        } catch (err) {
          this.cfg.logger?.warn?.({ err, identityId: existing.id }, "OIDC identity touch_last_seen failed");
        }
        // Keep role grants in sync with current group claim. Cheap (single
        // SELECT + idempotent inserts) and means an admin who maps a new
        // group→role doesn't need to wait for first-sight to take effect.
        await this.syncGroupRoleGrants(resolvedUserId, resolvedTenantId, groups);
      }

      const tags = await this.cfg.userRoleRepo.getAggregatedTagsByUserId(resolvedUserId);
      return {
        userId: resolvedUserId,
        tenantId: resolvedTenantId,
        tags,
        isNewUser,
      };
    });
  }

  private async createUserAndIdentity(
    issuer: string,
    subject: string,
    groups: string[],
  ): Promise<{ identity: { id: string; userId: string; tenantId: string }; isNewUser: boolean }> {
    const tenantId = this.cfg.defaultTenantId ?? "default";

    // Generate a high-entropy sentinel hash that fits the NOT NULL UNIQUE
    // schema constraint without ever matching a real bearer-token sha256.
    // The opaque-token resolution path hashes a Bearer credential via
    // sha256(token); this sentinel is constructed from random bytes so its
    // preimage is not derivable.
    const sentinelSecret = `oidc-sentinel:${randomBytes(32).toString("hex")}`;
    const sentinelHash = createHash("sha256").update(sentinelSecret).digest("hex");

    const userName = `oidc:${issuer}:${subject}`;

    let userId: string;
    let isNewUser = false;
    try {
      const user = await this.cfg.userRepo.create({ name: userName, token: sentinelHash });
      userId = user.id;
      isNewUser = true;
    } catch (err) {
      // Token collision (astronomically unlikely) or other DB error — surface.
      throw new Error(
        `OIDC provisioning failed creating user for ${userName}: ${(err as Error).message}`,
      );
    }

    let identityId: string;
    try {
      const created = await this.cfg.identityRepo.create({ tenantId, issuer, subject, userId });
      identityId = created.id;
    } catch (err) {
      // Race: another worker beat us to creating the identity row. Re-read
      // the winner's row, soft-delete our orphan user row, and use the
      // winner's user_id.
      const winner = await this.cfg.identityRepo.findByIssuerSubject(issuer, subject);
      if (!winner) {
        throw new Error(
          `OIDC identity create failed and no winning row found for ${issuer}:${subject}: ${(err as Error).message}`,
        );
      }
      // Best-effort cleanup of the orphan user row we created above.
      try {
        await this.cfg.userRepo.delete(userId);
      } catch (cleanupErr) {
        this.cfg.logger?.warn?.(
          { err: cleanupErr, orphanUserId: userId },
          "OIDC orphan user cleanup failed after identity race",
        );
      }
      return { identity: { id: winner.id, userId: winner.userId, tenantId: winner.tenantId }, isNewUser: false };
    }

    // Apply group→role mapping for the freshly-created user.
    await this.syncGroupRoleGrants(userId, tenantId, groups);

    this.cfg.logger?.info?.(
      { userId, issuer, subject, groups: groups.length },
      "OIDC user auto-provisioned",
    );

    return { identity: { id: identityId, userId, tenantId }, isNewUser };
  }

  private async syncGroupRoleGrants(userId: string, tenantId: string, groups: string[]): Promise<void> {
    if (groups.length === 0) return;
    const mappedRoleIds = await this.cfg.groupRoleMapRepo.findRoleIdsByGroups(tenantId, groups);
    if (mappedRoleIds.length === 0) return;
    const existingRoleIds = new Set(await this.cfg.userRoleRepo.findRoleIdsByUserId(userId));
    const toAdd = mappedRoleIds.filter((rid) => !existingRoleIds.has(rid));
    if (toAdd.length === 0) return;
    // We *add* rather than *replace* so any roles assigned outside SSO
    // (e.g. an admin granting an extra role manually) survive across logins.
    const merged = [...existingRoleIds, ...toAdd];
    await this.cfg.userRoleRepo.replaceUserRoles(userId, merged);
  }
}

