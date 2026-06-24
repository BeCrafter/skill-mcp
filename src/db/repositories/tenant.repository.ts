import { eq } from "drizzle-orm";
import type { DrizzleDB } from "../connection.js";
import { tenants } from "../schema.js";
import { DEFAULT_TENANT_ID } from "../../types/index.js";
import { ConflictError } from "../../utils/errors.js";

export interface TenantEntity {
  id: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * P0-3 — tenant skeleton repository.
 *
 * Single-tenant deployments only ever read the seeded `default` row, but the
 * repository is shaped for the multi-tenant follow-up: lookup, list, create,
 * and status update all key off `id`. Every other repository today writes
 * `tenant_id = 'default'` via the column DEFAULT, so this repository's
 * methods never need to be called from the request hot path until the
 * multi-tenant rollout begins.
 */
export class TenantRepository {
  constructor(private db: DrizzleDB) {}

  async findById(id: string): Promise<TenantEntity | null> {
    const rows = this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1).all();
    return rows.length > 0 ? this.toEntity(rows[0]) : null;
  }

  async findAll(): Promise<TenantEntity[]> {
    const rows = this.db.select().from(tenants).all();
    return rows.map(r => this.toEntity(r));
  }

  async ensureDefault(): Promise<TenantEntity> {
    const existing = await this.findById(DEFAULT_TENANT_ID);
    if (existing) return existing;
    const now = Date.now();
    this.db.insert(tenants).values({
      id: DEFAULT_TENANT_ID,
      name: "Default Tenant",
      description: "Auto-seeded for single-tenant deployments",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    return (await this.findById(DEFAULT_TENANT_ID)) as TenantEntity;
  }

  async create(input: { id: string; name: string; description?: string | null }): Promise<TenantEntity> {
    const existing = await this.findById(input.id);
    if (existing) throw new ConflictError(`Tenant "${input.id}" already exists`);
    const now = Date.now();
    this.db.insert(tenants).values({
      id: input.id,
      name: input.name,
      description: input.description ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    return (await this.findById(input.id)) as TenantEntity;
  }

  private toEntity(row: typeof tenants.$inferSelect): TenantEntity {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
