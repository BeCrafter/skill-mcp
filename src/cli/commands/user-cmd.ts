import { generateToken } from "../../utils/id.js";
import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { RoleRepository } from "../../db/repositories/role.repository.js";
import { UserRoleRepository } from "../../db/repositories/user-role.repository.js";
import { DomainEventBus } from "../../events/event-bus.js";
import { WebhookRepository } from "../../db/repositories/webhook.repository.js";
import { WebhookDeliveryRepository } from "../../db/repositories/webhook-delivery.repository.js";
import { WebhookService } from "../../services/webhook.service.js";
import { getLogger } from "../../utils/logger.js";
import { c, kv, table, section, ok, warn, kvWidth, hint, fail } from "../ui.js";
import { sha256 } from "../../utils/crypto.js";
import { requireAuth, readCredentials } from "./auth-cmd.js";
import { getServerUrl, apiCall } from "../remote-client.js";
import { ConflictError } from "../../utils/errors.js";

const PRIVILEGED_ROLE_NAMES = new Set(["superadmin", "admin"]);

function assertCanOperateOnCli(targetUserType: string, callerUserType: string, targetId?: string, callerId?: string): void {
  // 超管之间互相保护，但允许操作自己
  if (targetUserType === "superadmin") {
    if (targetId && callerId && targetId === callerId) return;
    fail("Cannot operate on superadmin user");
    closeDatabase();
    process.exit(1);
  }
  // admin 操作 admin 需要 superadmin 权限，但允许操作自己
  if (targetUserType === "admin" && callerUserType !== "superadmin") {
    if (targetId && callerId && targetId === callerId) return;
    fail("Only superadmin can operate on admin users");
    closeDatabase();
    process.exit(1);
  }
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
    eventBus: new DomainEventBus(),
  };
}

export async function userListAction(opts: { serverUrl?: string } = {}): Promise<void> {
  requireAuth();
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const creds = readCredentials()!;
    const users = await apiCall<Array<{ id: string; name: string | null; username: string | null; userType: string; status: string }>>(
      serverUrl, "GET", "/api/admin/users", { credentials: creds },
    );
    if (!users.length) { warn("No users found."); return; }
    console.log(section("Users", users.length));
    console.log();
    const rows = users.map(u => ({
      id: u.id, name: u.name ?? "", user_type: u.userType, status: u.status, roles: "",
    }));
    console.log(table(rows, [
      { key: "id", header: "ID", width: 2, format: v => c.dim(String(v)) },
      { key: "name", header: "NAME", width: 16, format: v => String(v) || c.dim("(unnamed)") },
      { key: "user_type", header: "TYPE", width: 12 },
      { key: "status", header: "STATUS", width: 10 },
    ]));
    console.log();
    return;
  }

  // Local mode
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
      username: user.username ?? "",
      userType: user.userType,
      status: user.status,
      roles: roleNames.join(", ") || "",
    });
  }

  console.log(table(rows, [
    { key: "id", header: "ID", width: 2, format: v => c.dim(String(v)) },
    { key: "name", header: "NAME", width: 16, format: v => String(v) || c.dim("(unnamed)") },
    { key: "username", header: "USERNAME", width: 12, format: v => String(v) || c.dim("-") },
    { key: "userType", header: "TYPE", width: 10 },
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

export async function userCreateAction(opts: { name?: string; roleIds?: string[]; ttl?: string; username?: string; password?: string; userType?: string; serverUrl?: string }): Promise<void> {
  requireAuth();
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const creds = readCredentials()!;
    const body: Record<string, unknown> = {};
    if (opts.name) body.name = opts.name;
    if (opts.username) body.username = opts.username;
    if (opts.password) body.password = opts.password;
    if (opts.userType) body.user_type = opts.userType;
    if (opts.roleIds) body.role_ids = opts.roleIds;
    if (opts.ttl) body.expires_in = parseTtlToMs(opts.ttl) / 1000;
    try {
      const user = await apiCall<{ id: string; name: string | null; username: string | null; user_type: string; token: string }>(
        serverUrl, "POST", "/api/admin/users", { body, credentials: creds },
      );
      ok(`User created: ${c.bold(user.username ?? user.name ?? user.id)}`);
      console.log(kv("id", c.dim(user.id)));
      if (user.username) console.log(kv("username", user.username));
      console.log(kv("user_type", user.user_type));
      console.log(kv("token", c.boldYellow(user.token)));
    } catch (err) {
      if (err instanceof Error && (err instanceof ConflictError || err.message.includes("already exists"))) {
        fail(`Username "${opts.username}" already exists`);
      } else {
        throw err;
      }
    }
    return;
  }

  // Local mode
  const creds = requireAuth();
  const { userRepo, userRoleRepo, roleRepo } = initRepos();

  // Password length validation
  if (opts.password && opts.password.length < 8) {
    fail("Password must be at least 8 characters");
    closeDatabase();
    process.exit(1);
  }

  // user_type enum validation
  if (opts.userType && !["user", "admin", "superadmin"].includes(opts.userType)) {
    fail("Invalid user_type. Must be 'user', 'admin', or 'superadmin'");
    closeDatabase();
    process.exit(1);
  }

  // Only superadmin can create admin/superadmin users
  if ((opts.userType === "admin" || opts.userType === "superadmin") && creds.userType !== "superadmin") {
    fail("Only superadmin can create admin/superadmin users");
    closeDatabase();
    process.exit(1);
  }

  // role_ids containing privileged roles requires superadmin
  if (opts.roleIds?.length && creds.userType !== "superadmin") {
    const roles = await roleRepo.findByIds(opts.roleIds);
    const hasPrivileged = roles.some(r => PRIVILEGED_ROLE_NAMES.has(r.name));
    if (hasPrivileged) {
      fail("Only superadmin can assign superadmin/admin roles");
      closeDatabase();
      process.exit(1);
    }
  }

  const token = generateToken();
  const tokenExpiresAt = opts.ttl ? Date.now() + parseTtlToMs(opts.ttl) : null;
  const hash = sha256(token);

  let passwordHash: string | undefined;
  if (opts.password) {
    const { hashSync } = await import("bcryptjs");
    passwordHash = hashSync(opts.password, 12);
  }

  try {
    const user = await userRepo.create({
      name: opts.name,
      username: opts.username,
      passwordHash,
      userType: opts.userType ?? "user",
      token: hash,
      tokenPlaintext: token,
      tokenExpiresAt,
    });

    // Auto-assign admin role for admin users if no explicit roles
    if (opts.userType === "admin" && !opts.roleIds?.length) {
      const allRoles = await roleRepo.findAll();
      const adminRole = allRoles.find(r => r.name === "admin");
      if (adminRole) {
        await userRoleRepo.replaceUserRoles(user.id, [adminRole.id]);
      }
    } else if (opts.roleIds?.length) {
      await userRoleRepo.replaceUserRoles(user.id, opts.roleIds);
    }

    const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);

    console.log(section("user created", undefined, kvWidth(12, c.dim(user.id), user.name ?? "(unnamed)", user.userType, token, tags.join(", "))));
    console.log();
    console.log(kv("id", c.dim(user.id)));
    console.log(kv("name", user.name ?? c.dim("(unnamed)")));
    if (user.username) console.log(kv("username", user.username));
    console.log(kv("userType", user.userType));
    console.log(kv("token", c.boldYellow(token)));
    if (tokenExpiresAt) console.log(kv("expires", new Date(tokenExpiresAt).toISOString()));
    console.log(kv("tags", tags.join(", ") || c.dim("(none)")));

    console.log(`\n  ${c.boldYellow("⚠")}  Save the token above — it cannot be retrieved again.\n`);
  } catch (err) {
    if (err instanceof Error && (err instanceof ConflictError || err.message.includes("already exists"))) {
      fail(`Username "${opts.username}" already exists`);
    } else {
      throw err;
    }
  }
  closeDatabase();
}

// P0-4 — `skill-mcp user rotate-token <id> [--ttl 30d] [--grace 7d]`
export async function userRotateTokenAction(userId: string, opts: { ttl?: string; grace?: string; serverUrl?: string } = {}): Promise<void> {
  requireAuth();
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const creds = readCredentials()!;
    const body: Record<string, unknown> = {};
    if (opts.ttl) body.expires_in = parseTtlToMs(opts.ttl) / 1000;
    if (opts.grace) body.grace_seconds = parseTtlToMs(opts.grace) / 1000;
    const result = await apiCall<{ id: string; token: string; token_expires_at: number | null; previous_token_expires_at: number | null }>(
      serverUrl, "POST", `/api/admin/users/${userId}/rotate-token`, { body, credentials: creds },
    );
    console.log(section("token rotated"));
    console.log();
    console.log(kv("id", c.dim(result.id)));
    console.log(kv("token", c.boldYellow(result.token)));
    if (result.token_expires_at) console.log(kv("expires", new Date(result.token_expires_at).toISOString()));
    console.log(kv("grace until", result.previous_token_expires_at ? new Date(result.previous_token_expires_at).toISOString() : c.dim("(immediate)")));
    hint("Old token still valid until grace expires");
    return;
  }

  // Local mode
  const creds = requireAuth();
  const { userRepo, webhookRepo, webhookDeliveryRepo } = initRepos();
  const user = await userRepo.findById(userId);
  if (!user) {
    fail(`User not found: ${userId}`, "Use `skill-mcp user list` to see available users");
    closeDatabase();
    process.exit(1);
  }
  assertCanOperateOnCli(user.userType, creds.userType, user.id, creds.userId);
  const tokenExpiresAt = opts.ttl ? Date.now() + parseTtlToMs(opts.ttl) : null;
  const graceMs = opts.grace ? parseTtlToMs(opts.grace) : undefined;
  const token = generateToken();
  const hash = sha256(token);
  const rotated = await userRepo.rotateToken(userId, hash, { graceMs, tokenExpiresAt, tokenPlaintext: token });
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

export async function userGetAction(userId: string, opts: { serverUrl?: string } = {}): Promise<void> {
  const creds = requireAuth();
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const user = await apiCall<{
      id: string; name: string | null; username: string | null;
      userType: string; status: string;
      roles: Array<{ name: string; tags: string[] }>; tags: string[];
      token_plaintext?: string; token_expires_at?: number | null;
    }>(serverUrl, "GET", `/api/admin/users/${userId}`, { credentials: readCredentials()! });

    console.log(section("user"));
    console.log();
    console.log(kv("id", c.dim(user.id), 14));
    console.log(kv("name", user.name ?? c.dim("(unnamed)"), 14));
    if (user.username) console.log(kv("username", user.username, 14));
    console.log(kv("userType", user.userType, 14));
    console.log(kv("status", user.status, 14));
    console.log(kv("roles", user.roles?.map(r => `${r.name} [${r.tags?.join(",")}]`).join("; ") || c.dim("(none)"), 14));

    if (user.token_plaintext) {
      console.log(kv("token", c.boldYellow(user.token_plaintext), 14));
      if (user.token_expires_at) {
        const expiresDate = new Date(user.token_expires_at).toLocaleString("zh-CN");
        const isExpired = user.token_expires_at < Date.now();
        console.log(kv("token expires", isExpired ? c.red(`${expiresDate} (已过期)`) : expiresDate, 14));
      } else {
        console.log(kv("token expires", c.green("永久有效"), 14));
      }
    }

    console.log();
    closeDatabase();
    return;
  }

  // Local mode
  const { userRepo, userRoleRepo, roleRepo } = initRepos();
  const user = await userRepo.findById(userId);
  if (!user) {
    fail(`User not found: ${userId}`, "Use `skill-mcp user list` to see available users");
    closeDatabase();
    process.exit(1);
  }
  const roleIds = await userRoleRepo.findRoleIdsByUserId(userId);
  const roleRows = await roleRepo.findByIds(roleIds);
  const roles = roleRows.map(r => ({ id: r.id, name: r.name, tags: r.tags }));

  console.log(section("user", undefined, kvWidth(14, c.dim(user.id), user.name ?? "(unnamed)", user.status, roles.map(r => `${r.name} [${r.tags.join(",")}]`).join("; "))));
  console.log();
  console.log(kv("id", c.dim(user.id), 14));
  console.log(kv("name", user.name ?? c.dim("(unnamed)"), 14));
  if (user.username) console.log(kv("username", user.username, 14));
  console.log(kv("userType", user.userType, 14));
  console.log(kv("status", user.status, 14));
  console.log(kv("roles", roles.map(r => `${r.name} [${r.tags.join(",")}]`).join("; ") || c.dim("(none)"), 14));

  // Show token if caller has permission (same as rotate-token: can operate on this user)
  try {
    assertCanOperateOnCli(user.userType, creds.userType, user.id, creds.userId);
    if (user.tokenPlaintext) {
      console.log(kv("token", c.boldYellow(user.tokenPlaintext), 14));
      if (user.tokenExpiresAt) {
        const expiresDate = new Date(user.tokenExpiresAt).toLocaleString("zh-CN");
        const isExpired = user.tokenExpiresAt < Date.now();
        console.log(kv("token expires", isExpired ? c.red(`${expiresDate} (已过期)`) : expiresDate, 14));
      } else {
        console.log(kv("token expires", c.green("永久有效"), 14));
      }
    } else {
      console.log(kv("token", c.dim("(not available - token was created before this feature)"), 14));
    }
  } catch {
    // No permission to see token - don't show it
  }

  console.log();
  closeDatabase();
}

export async function userDeleteAction(userId: string, opts: { serverUrl?: string } = {}): Promise<void> {
  const creds = requireAuth();
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    await apiCall(serverUrl, "DELETE", `/api/admin/users/${userId}`, { credentials: readCredentials()! });
    ok(`${c.bold("Deleted")}  user  ${c.dim(userId)}`);
    return;
  }

  // Local mode
  if (userId === creds.userId) {
    fail("Cannot delete your own account");
    return;
  }
  const { userRepo, userRoleRepo } = initRepos();
  const target = await userRepo.findById(userId);
  if (!target) {
    fail(`User not found: ${userId}`, "Use `skill-mcp user list` to see available users");
    closeDatabase();
    process.exit(1);
  }
  assertCanOperateOnCli(target.userType, creds.userType, target.id, creds.userId);
  await userRoleRepo.deleteByUserId(userId);
  await userRepo.delete(userId);
  ok(`${c.bold("Deleted")}  user  ${c.dim(userId)}`);
  hint("Run `skill-mcp user list` to see remaining users");
}

export async function userAssignRolesAction(userId: string, roleIds: string[], opts: { serverUrl?: string } = {}): Promise<void> {
  requireAuth();
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const creds = readCredentials()!;
    await apiCall(serverUrl, "PUT", `/api/admin/users/${userId}/roles`, { body: { role_ids: roleIds }, credentials: creds });
    ok(`${c.bold("Roles updated")}  user  ${c.dim(userId)}`);
    return;
  }

  // Local mode
  const creds = requireAuth();
  const { userRepo, userRoleRepo, roleRepo, eventBus } = initRepos();
  const user = await userRepo.findById(userId);
  if (!user) {
    fail(`User not found: ${userId}`, "Use `skill-mcp user list` to see available users");
    closeDatabase();
    process.exit(1);
  }
  assertCanOperateOnCli(user.userType, creds.userType, user.id, creds.userId);
  // Check privileged role assignment
  if (roleIds.length > 0 && creds.userType !== "superadmin") {
    const roles = await roleRepo.findByIds(roleIds);
    const hasPrivileged = roles.some(r => PRIVILEGED_ROLE_NAMES.has(r.name));
    if (hasPrivileged) {
      fail("Only superadmin can assign superadmin/admin roles");
      closeDatabase();
      process.exit(1);
    }
  }
  await userRoleRepo.replaceUserRoles(userId, roleIds);
  eventBus.publish({ type: "user:roles_changed", userId });
  const tags = await userRoleRepo.getAggregatedTagsByUserId(userId);
  ok(`${c.bold("Roles updated")}  user  ${c.dim(userId)}`, [
    { key: "tags", value: tags.join(", ") || c.dim("(none)") },
  ]);
}
