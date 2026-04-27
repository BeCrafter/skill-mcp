import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "../connection.js";
import { users } from "../schema.js";

export interface UserEntity {
  id: string;
  name: string | null;
  token: string;
  status: string;
  createdAt: number | null;
  updatedAt: number | null;
}

export class UserRepository {
  constructor(private db: DrizzleDB) {}

  async findById(id: string): Promise<UserEntity | null> {
    const rows = this.db.select().from(users).where(eq(users.id, id)).limit(1).all();
    return rows.length > 0 ? this.toEntity(rows[0]) : null;
  }

  async findByToken(tokenHash: string): Promise<UserEntity | null> {
    const rows = this.db.select().from(users).where(eq(users.token, tokenHash)).limit(1).all();
    return rows.length > 0 ? this.toEntity(rows[0]) : null;
  }

  async findAll(): Promise<UserEntity[]> {
    const rows = this.db.select().from(users).all();
    return rows.map(r => this.toEntity(r));
  }

  async create(input: { name?: string; token: string }): Promise<UserEntity> {
    const now = Date.now();
    const id = randomUUID();
    this.db.insert(users).values({
      id,
      name: input.name ?? null,
      token: input.token,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.findById(id) as Promise<UserEntity>;
  }

  async update(id: string, input: { name?: string; status?: string }): Promise<UserEntity | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    const updateData: Record<string, unknown> = { updatedAt: Date.now() };
    if (input.name !== undefined) updateData.name = input.name;
    if (input.status !== undefined) updateData.status = input.status;
    this.db.update(users).set(updateData).where(eq(users.id, id)).run();
    return this.findById(id);
  }

  async updateToken(id: string, tokenHash: string): Promise<void> {
    this.db.update(users).set({ token: tokenHash, updatedAt: Date.now() }).where(eq(users.id, id)).run();
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.delete(users).where(eq(users.id, id)).run();
    return result.changes > 0;
  }

  private toEntity(row: typeof users.$inferSelect): UserEntity {
    return {
      id: row.id,
      name: row.name,
      token: row.token,
      status: row.status ?? "active",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
