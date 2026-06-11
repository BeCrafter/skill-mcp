import { randomUUID, createHash } from "node:crypto";
import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { RoleRepository } from "../../db/repositories/role.repository.js";
import { UserRoleRepository } from "../../db/repositories/user-role.repository.js";
import { WebhookRepository } from "../../db/repositories/webhook.repository.js";
import { WebhookDeliveryRepository } from "../../db/repositories/webhook-delivery.repository.js";
import { WebhookService } from "../../services/webhook.service.js";
import { getLogger } from "../../utils/logger.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function initRepos() {
  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  return {
    userRepo: new UserRepository(db),
    roleRepo: new RoleRepository(db),
    userRoleRepo: new UserRoleRepository(db),
    webhookRepo: new WebhookRepository(db),
    webhookDeliveryRepo: new WebhookDeliveryRepository(db),
  };
}

export async function userListAction(): Promise<void> {
  const { userRepo, userRoleRepo, roleRepo } = initRepos();
  const users = await userRepo.findAll();
  if (users.length === 0) {
    console.log("No users found.");
    closeDatabase();
    return;
  }
  for (const user of users) {
    const roleIds = await userRoleRepo.findRoleIdsByUserId(user.id);
    const roleRows = await roleRepo.findByIds(roleIds);
    const roleNames = roleRows.map(r => r.name);
    console.log(`  ${user.id}  ${user.name ?? "(unnamed)"}  status=${user.status}  roles=[${roleNames.join(", ")}]`);
  }
  closeDatabase();
}

// P0-4 — accept human-friendly TTL strings ("30d", "12h", "90m", "3600s") so
// the CLI can mint ephemeral tokens without a date calculator.
function parseTtlToMs(ttl: string): number {
  const match = ttl.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid --ttl: ${ttl} (expected like 30d, 12h, 45m, 3600s)`);
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multiplier = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * multiplier;
}

export async function userCreateAction(opts: { name?: string; roleIds?: string[]; ttl?: string }): Promise<void> {
  const { userRepo, userRoleRepo } = initRepos();
  const tokenExpiresAt = opts.ttl ? Date.now() + parseTtlToMs(opts.ttl) : null;
  const token = `sk-live-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const hash = sha256(token);
  const user = await userRepo.create({ name: opts.name, token: hash, tokenExpiresAt });
  if (opts.roleIds?.length) {
    await userRoleRepo.replaceUserRoles(user.id, opts.roleIds);
  }
  const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);
  console.log("User created:");
  console.log(`  ID:    ${user.id}`);
  console.log(`  Name:  ${user.name ?? "(unnamed)"}`);
  console.log(`  Token: ${token}`);
  if (tokenExpiresAt) console.log(`  Expires: ${new Date(tokenExpiresAt).toISOString()}`);
  console.log(`  Tags:  [${tags.join(", ")}]`);
  console.log("\n  ⚠ Save the token above — it cannot be retrieved again.");
  closeDatabase();
}

// P0-4 — `skill-mcp user rotate-token <id> [--ttl 30d] [--grace 7d]`
export async function userRotateTokenAction(userId: string, opts: { ttl?: string; grace?: string } = {}): Promise<void> {
  const { userRepo, webhookRepo, webhookDeliveryRepo } = initRepos();
  const user = await userRepo.findById(userId);
  if (!user) {
    console.error(`User not found: ${userId}`);
    closeDatabase();
    process.exit(1);
  }
  const tokenExpiresAt = opts.ttl ? Date.now() + parseTtlToMs(opts.ttl) : null;
  const graceMs = opts.grace ? parseTtlToMs(opts.grace) : undefined;
  const token = `sk-live-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const hash = sha256(token);
  const rotated = await userRepo.rotateToken(userId, hash, { graceMs, tokenExpiresAt });
  if (!rotated) {
    console.error(`Rotate failed: user disappeared mid-operation`);
    closeDatabase();
    process.exit(1);
  }
  console.log("Token rotated:");
  console.log(`  ID:    ${rotated.id}`);
  console.log(`  Token: ${token}`);
  if (tokenExpiresAt) console.log(`  Expires: ${new Date(tokenExpiresAt).toISOString()}`);
  console.log(`  Grace until: ${rotated.previousTokenExpiresAt ? new Date(rotated.previousTokenExpiresAt).toISOString() : "(immediate)"}`);
  console.log("\n  ⚠ Old token still valid until grace expires.");

  // P1-16 — fire-and-forget webhook fan-out. CLI runs in a one-shot process,
  // so we just enqueue the delivery rows; the serve worker picks them up.
  try {
    const config = getConfig();
    const allowPlaintext = config.app.env !== "production";
    const webhookService = new WebhookService(webhookRepo, webhookDeliveryRepo, getLogger(), { allowPlaintext });
    webhookService.publishEvent("user.token_rotated", rotated.tenantId, {
      user_id: rotated.id,
      rotated_at: Date.now(),
      previous_token_expires_at: rotated.previousTokenExpiresAt ?? null,
    });
  } catch {
    // CLI must succeed even if webhook fan-out fails.
  }
  closeDatabase();
}

export async function userGetAction(userId: string): Promise<void> {
  const { userRepo, userRoleRepo, roleRepo } = initRepos();
  const user = await userRepo.findById(userId);
  if (!user) {
    console.error(`User not found: ${userId}`);
    closeDatabase();
    process.exit(1);
  }
  const tags = await userRoleRepo.getAggregatedTagsByUserId(userId);
  const roleIds = await userRoleRepo.findRoleIdsByUserId(userId);
  const roleRows = await roleRepo.findByIds(roleIds);
  const roles = roleRows.map(r => ({ id: r.id, name: r.name, tags: r.tags }));
  console.log(`User: ${user.id}`);
  console.log(`  Name:   ${user.name ?? "(unnamed)"}`);
  console.log(`  Status: ${user.status}`);
  console.log(`  Roles:  ${roles.map(r => `${r.name} [${r.tags.join(",")}]`).join("; ") || "(none)"}`);
  console.log(`  Tags:   [${tags.join(", ")}]`);
  closeDatabase();
}

export async function userDeleteAction(userId: string): Promise<void> {
  const { userRepo, userRoleRepo } = initRepos();
  await userRoleRepo.deleteByUserId(userId);
  const deleted = await userRepo.delete(userId);
  if (!deleted) {
    console.error(`User not found: ${userId}`);
    closeDatabase();
    process.exit(1);
  }
  console.log(`User ${userId} deleted.`);
  closeDatabase();
}

export async function userAssignRolesAction(userId: string, roleIds: string[]): Promise<void> {
  const { userRepo, userRoleRepo } = initRepos();
  const user = await userRepo.findById(userId);
  if (!user) {
    console.error(`User not found: ${userId}`);
    closeDatabase();
    process.exit(1);
  }
  await userRoleRepo.replaceUserRoles(userId, roleIds);
  const tags = await userRoleRepo.getAggregatedTagsByUserId(userId);
  console.log(`Roles updated for user ${userId}.`);
  console.log(`  Tags: [${tags.join(", ")}]`);
  closeDatabase();
}
