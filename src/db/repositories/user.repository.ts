import { eq, or } from "drizzle-orm";
import { generateId, generateUniqueId } from "../../utils/id.js";
import type { DrizzleDB } from "../connection.js";
import { users } from "../schema.js";
import { ConflictError } from "../../utils/errors.js";

export interface UserEntity {
  id: string;
  name: string | null;
  username: string | null;
  passwordHash: string | null;
  userType: string;
  token: string;
  tokenPlaintext: string | null;
  status: string;
  tokenExpiresAt: number | null;
  previousToken: string | null;
  previousTokenExpiresAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
}

// P0-4 — token rotation grace defaults to 7 days. Surfaced as a constant so
// the admin handler, the rotate-token CLI, and the cleanup background job
// share a single source of truth.
export const TOKEN_ROTATION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export class UserRepository {
  constructor(private db: DrizzleDB) {}

  async findById(id: string): Promise<UserEntity | null> {
    const rows = this.db.select().from(users).where(eq(users.id, id)).limit(1).all();
    return rows.length > 0 ? this.toEntity(rows[0]) : null;
  }

  /**
   * Resolve a sha256(token) hash to a user, honoring the dual-token grace
   * window (P0-4). The current `token` slot is preferred; we fall back to
   * `previous_token` only when its `previous_token_expires_at` is still in the
   * future. Returns null when:
   *   - no row matches either slot
   *   - the matched row's primary token has expired (`token_expires_at < now`)
   *   - only the previous slot matched and its grace window has passed
   * The expiry checks happen in JS rather than SQL so the logic stays in one
   * place and is easy to audit.
   */
  async findByToken(tokenHash: string): Promise<UserEntity | null> {
    return this._findByTokenImpl(tokenHash);
  }

  private async _findByTokenImpl(tokenHash: string): Promise<UserEntity | null> {
    const now = Date.now();
    const rows = this.db
      .select()
      .from(users)
      .where(or(eq(users.token, tokenHash), eq(users.previousToken, tokenHash)))
      .limit(2)
      .all();
    if (rows.length === 0) return null;
    // Prefer the current-token match if both rows surface (defensive: shouldn't
    // happen because UNIQUE(token) holds, but the OR can return up to 2 rows
    // if a stale previous_token was set on a different account).
    const currentMatch = rows.find(r => r.token === tokenHash);
    const previousMatch = rows.find(r => r.previousToken === tokenHash && r.token !== tokenHash);
    if (currentMatch) {
      if (currentMatch.tokenExpiresAt !== null && currentMatch.tokenExpiresAt !== undefined && currentMatch.tokenExpiresAt <= now) {
        return null;
      }
      return this.toEntity(currentMatch);
    }
    if (previousMatch) {
      if (previousMatch.previousTokenExpiresAt === null || previousMatch.previousTokenExpiresAt === undefined) return null;
      if (previousMatch.previousTokenExpiresAt <= now) return null;
      return this.toEntity(previousMatch);
    }
    return null;
  }

  async findAll(): Promise<UserEntity[]> {
    const rows = this.db.select().from(users).all();
    return rows.map(r => this.toEntity(r));
  }

  async findByUsername(username: string): Promise<UserEntity | null> {
    const rows = this.db.select().from(users).where(eq(users.username, username)).limit(1).all();
    return rows.length > 0 ? this.toEntity(rows[0]) : null;
  }

  async create(input: { name?: string; username?: string; passwordHash?: string; userType?: string; token: string; tokenPlaintext?: string; tokenExpiresAt?: number | null }): Promise<UserEntity> {
    if (input.username) {
      const existing = await this.findByUsername(input.username);
      if (existing) throw new ConflictError(`Username "${input.username}" already exists`);
    }
    const now = Date.now();
    const id = await generateUniqueId(() => generateId("usr_"), async (id) => !!(await this.findById(id)));
    this.db.insert(users).values({
      id,
      name: input.name ?? null,
      username: input.username ?? null,
      passwordHash: input.passwordHash ?? null,
      userType: input.userType ?? "user",
      token: input.token,
      tokenPlaintext: input.tokenPlaintext ?? null,
      status: "active",
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.findById(id) as Promise<UserEntity>;
  }

  async update(id: string, input: { name?: string; status?: string; username?: string; userType?: string }): Promise<UserEntity | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    if (input.username !== undefined && input.username !== existing.username) {
      const conflict = await this.findByUsername(input.username);
      if (conflict) throw new ConflictError(`Username "${input.username}" already exists`);
    }
    const updateData: Record<string, unknown> = { updatedAt: Date.now() };
    if (input.name !== undefined) updateData.name = input.name;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.username !== undefined) updateData.username = input.username;
    if (input.userType !== undefined) updateData.userType = input.userType;
    this.db.update(users).set(updateData).where(eq(users.id, id)).run();
    return this.findById(id);
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    this.db.update(users).set({ passwordHash, updatedAt: Date.now() }).where(eq(users.id, id)).run();
  }

  async updateToken(id: string, tokenHash: string): Promise<void> {
    this.db.update(users).set({ token: tokenHash, updatedAt: Date.now() }).where(eq(users.id, id)).run();
  }

  /**
   * P0-4 — atomic token rotation. Move the current token into the previous
   * slot with a fresh grace expiry, and write the new token (with optional
   * fresh expiry) into the primary slot. Both old and new tokens accept auth
   * until `previousTokenExpiresAt` passes.
   */
  async rotateToken(
    id: string,
    newTokenHash: string,
    opts: { graceMs?: number; tokenExpiresAt?: number | null; tokenPlaintext?: string } = {},
  ): Promise<UserEntity | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    const now = Date.now();
    const graceMs = opts.graceMs ?? TOKEN_ROTATION_GRACE_MS;
    this.db.update(users).set({
      token: newTokenHash,
      tokenPlaintext: opts.tokenPlaintext ?? null,
      tokenExpiresAt: opts.tokenExpiresAt ?? null,
      previousToken: existing.token,
      previousTokenExpiresAt: now + graceMs,
      updatedAt: now,
    }).where(eq(users.id, id)).run();
    return this.findById(id);
  }

  /**
   * Clear the previous-token slot. Called when an admin wants to invalidate
   * the old token before its grace window expires (e.g. compromise response),
   * and by the periodic cleanup sweep once `previousTokenExpiresAt` passes.
   */
  async clearPreviousToken(id: string): Promise<void> {
    this.db.update(users).set({
      previousToken: null,
      previousTokenExpiresAt: null,
      updatedAt: Date.now(),
    }).where(eq(users.id, id)).run();
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.delete(users).where(eq(users.id, id)).run();
    return result.changes > 0;
  }

  private toEntity(row: typeof users.$inferSelect): UserEntity {
    return {
      id: row.id,
      name: row.name,
      username: row.username ?? null,
      passwordHash: row.passwordHash ?? null,
      userType: row.userType ?? "user",
      token: row.token,
      tokenPlaintext: row.tokenPlaintext ?? null,
      status: row.status ?? "active",
      tokenExpiresAt: row.tokenExpiresAt ?? null,
      previousToken: row.previousToken ?? null,
      previousTokenExpiresAt: row.previousTokenExpiresAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
