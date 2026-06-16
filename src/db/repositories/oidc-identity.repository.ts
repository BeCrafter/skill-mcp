import { and, eq } from "drizzle-orm";
import { shortId, generateUniqueId } from "../../utils/id.js";
import type { DrizzleDB } from "../connection.js";
import { oidcIdentities } from "../schema.js";
import { withSpan } from "../../telemetry/spans.js";

export interface OidcIdentityEntity {
  id: string;
  tenantId: string;
  issuer: string;
  subject: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * P1-14 stage 3 — sidecar table mapping a verified `(issuer, subject)` to
 * a real `users.id`. Stage 2's transient `oidc:<iss>:<sub>` userIds had no
 * persistent identity and no role grants; this repo backs the provisioner
 * that closes the gap. Uniqueness is on `(issuer, subject)` (see migration
 * 0016 for rationale on why tenant is not part of the key).
 */
export class OidcIdentityRepository {
  constructor(private db: DrizzleDB) {}

  async findByIssuerSubject(issuer: string, subject: string): Promise<OidcIdentityEntity | null> {
    return withSpan(
      "db.query",
      { attributes: { "db.repo": "oidc_identities", "db.method": "findByIssuerSubject" } },
      async () => {
        const rows = this.db
          .select()
          .from(oidcIdentities)
          .where(and(eq(oidcIdentities.issuer, issuer), eq(oidcIdentities.subject, subject)))
          .limit(1)
          .all();
        return rows.length > 0 ? this.toEntity(rows[0]) : null;
      },
    );
  }

  async findByUserId(userId: string): Promise<OidcIdentityEntity[]> {
    const rows = this.db
      .select()
      .from(oidcIdentities)
      .where(eq(oidcIdentities.userId, userId))
      .all();
    return rows.map((r) => this.toEntity(r));
  }

  async create(input: {
    tenantId?: string;
    issuer: string;
    subject: string;
    userId: string;
  }): Promise<OidcIdentityEntity> {
    const id = await generateUniqueId(() => shortId(), async (id) => {
      const row = this.db.select({ id: oidcIdentities.id }).from(oidcIdentities).where(eq(oidcIdentities.id, id)).get();
      return !!row;
    });
    const now = Date.now();
    this.db
      .insert(oidcIdentities)
      .values({
        id,
        tenantId: input.tenantId ?? "default",
        issuer: input.issuer,
        subject: input.subject,
        userId: input.userId,
        createdAt: now,
        lastSeenAt: now,
      })
      .run();
    return {
      id,
      tenantId: input.tenantId ?? "default",
      issuer: input.issuer,
      subject: input.subject,
      userId: input.userId,
      createdAt: now,
      lastSeenAt: now,
    };
  }

  async touchLastSeen(id: string): Promise<void> {
    this.db
      .update(oidcIdentities)
      .set({ lastSeenAt: Date.now() })
      .where(eq(oidcIdentities.id, id))
      .run();
  }

  async deleteByUserId(userId: string): Promise<void> {
    this.db.delete(oidcIdentities).where(eq(oidcIdentities.userId, userId)).run();
  }

  private toEntity(row: typeof oidcIdentities.$inferSelect): OidcIdentityEntity {
    return {
      id: row.id,
      tenantId: row.tenantId ?? "default",
      issuer: row.issuer,
      subject: row.subject,
      userId: row.userId,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
    };
  }
}
