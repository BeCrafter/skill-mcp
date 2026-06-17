import { createHash } from "node:crypto";
import { generateToken } from "../../utils/id.js";
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
import { c, kv, table, section, ok, warn, kvWidth, hint, fail } from "../ui.js";

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
    warn("No users found.");
    closeDatabase();
    return;
  }

  console.log(section("Users", users.length));
  console.log();

  const rows = [];
  for (const user of users) {
    const roleIds = await userRoleRepo.findRoleIdsByUserId(user.id);
    const roleRows = await roleRepo.findByIds(roleIds);
    const roleNames = roleRows.map(r => r.name);
    rows.push({
      id: user.id,
      name: user.name ?? "",
      status: user.status,
      roles: roleNames.join(", ") || "",
    });
  }

  console.log(table(rows, [
    { key: "id", header: "ID", width: 2, format: v => c.dim(String(v)) },
    { key: "name", header: "NAME", width: 16, format: v => String(v) || c.dim("(unnamed)") },
    { key: "status", header: "STATUS", width: 10 },
    { key: "roles", header: "ROLES", width: 24, format: v => String(v) || c.dim("(none)") },
  ]));

  console.log();
  closeDatabase();
}

// P0-4 — accept human-friendly TTL strings ("30d", "12h", "90m", "3600s") so
// the CLI can mint ephemeral tokens without a date calculator.
function parseTtlToMs(ttl: string): number {
  const match = ttl.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid TTL format: "${ttl}". Use e.g. "30d", "12h", "90m", "3600s".`);
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    default: throw new Error(`Invalid TTL unit: "${match[2]}"`);
  }
}

export async function userCreateAction(opts: { name?: string; roleIds?: string[]; ttl?: string }): Promise<void> {
  const { userRepo, userRoleRepo } = initRepos();
  const token = generateToken();
  const tokenExpiresAt = opts.ttl ? Date.now() + parseTtlToMs(opts.ttl) : null;
  const hash = sha256(token);
  const user = await userRepo.create({ name: opts.name, token: hash, tokenExpiresAt });
  if (opts.roleIds?.length) {
    await userRoleRepo.replaceUserRoles(user.id, opts.roleIds);
  }
  const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);

    console.log(section("user created", undefined, kvWidth(12, c.dim(user.id), user.name ?? "(unnamed)", token, tags.join(", "))));
    console.log();
    console.log(kv("id", c.dim(user.id)));
    console.log(kv("name", user.name ?? c.dim("(unnamed)")));
    console.log(kv("token", c.boldYellow(token)));
    if (tokenExpiresAt) console.log(kv("expires", new Date(tokenExpiresAt).toISOString()));
    console.log(kv("tags", tags.join(", ") || c.dim("(none)")));

  console.log(`\n  ${c.boldYellow("⚠")}  Save the token above — it cannot be retrieved again.\n`);
  closeDatabase();
}

// P0-4 — `skill-mcp user rotate-token <id> [--ttl 30d] [--grace 7d]`
export async function userRotateTokenAction(userId: string, opts: { ttl?: string; grace?: string } = {}): Promise<void> {
  const { userRepo, webhookRepo, webhookDeliveryRepo } = initRepos();
  const user = await userRepo.findById(userId);
  if (!user) {
    fail(`User not found: ${userId}`, "Use `skill-mcp user list` to see available users");
    closeDatabase();
    process.exit(1);
  }
  const tokenExpiresAt = opts.ttl ? Date.now() + parseTtlToMs(opts.ttl) : null;
  const graceMs = opts.grace ? parseTtlToMs(opts.grace) : undefined;
  const token = generateToken();
  const hash = sha256(token);
  const rotated = await userRepo.rotateToken(userId, hash, { graceMs, tokenExpiresAt });
  if (!rotated) {
    fail("Rotate failed: user disappeared mid-operation", "This is a transient error, try again");
    closeDatabase();
    process.exit(1);
  }

    console.log(section("token rotated", undefined, kvWidth(12, c.dim(rotated.id), token, rotated.previousTokenExpiresAt ? new Date(rotated.previousTokenExpiresAt).toISOString() : "(immediate)")));
    console.log();
    console.log(kv("id", c.dim(rotated.id)));
    console.log(kv("token", c.boldYellow(token)));
    if (tokenExpiresAt) console.log(kv("expires", new Date(tokenExpiresAt).toISOString()));
    console.log(kv("grace until", rotated.previousTokenExpiresAt ? new Date(rotated.previousTokenExpiresAt).toISOString() : c.dim("(immediate)")));

  hint("Old token still valid until grace expires");

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
    fail(`User not found: ${userId}`, "Use `skill-mcp user list` to see available users");
    closeDatabase();
    process.exit(1);
  }
  const tags = await userRoleRepo.getAggregatedTagsByUserId(userId);
  const roleIds = await userRoleRepo.findRoleIdsByUserId(userId);
  const roleRows = await roleRepo.findByIds(roleIds);
  const roles = roleRows.map(r => ({ id: r.id, name: r.name, tags: r.tags }));

    console.log(section("user", undefined, kvWidth(12, c.dim(user.id), user.name ?? "(unnamed)", user.status, roles.map(r => `${r.name} [${r.tags.join(",")}]`).join("; "), tags.join(", "))));
    console.log();
    console.log(kv("id", c.dim(user.id)));
    console.log(kv("name", user.name ?? c.dim("(unnamed)")));
    console.log(kv("status", user.status));
    console.log(kv("roles", roles.map(r => `${r.name} [${r.tags.join(",")}]`).join("; ") || c.dim("(none)")));
    console.log(kv("tags", tags.join(", ") || c.dim("(none)")));

  console.log();
  closeDatabase();
}

export async function userDeleteAction(userId: string): Promise<void> {
  const { userRepo, userRoleRepo } = initRepos();
  await userRoleRepo.deleteByUserId(userId);
  const deleted = await userRepo.delete(userId);
  if (!deleted) {
    fail(`User not found: ${userId}`, "Use `skill-mcp user list` to see available users");
    closeDatabase();
    process.exit(1);
  }
  ok(`${c.bold("Deleted")}  user  ${c.dim(userId)}`);
  hint("Run `skill-mcp user list` to see remaining users");
}

export async function userAssignRolesAction(userId: string, roleIds: string[]): Promise<void> {
  const { userRepo, userRoleRepo } = initRepos();
  const user = await userRepo.findById(userId);
  if (!user) {
    fail(`User not found: ${userId}`, "Use `skill-mcp user list` to see available users");
    closeDatabase();
    process.exit(1);
  }
  await userRoleRepo.replaceUserRoles(userId, roleIds);
  const tags = await userRoleRepo.getAggregatedTagsByUserId(userId);
  ok(`${c.bold("Roles updated")}  user  ${c.dim(userId)}`, [
    { key: "tags", value: tags.join(", ") || c.dim("(none)") },
  ]);
}
