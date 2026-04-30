import { randomUUID, createHash } from "node:crypto";
import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { RoleRepository } from "../../db/repositories/role.repository.js";
import { UserRoleRepository } from "../../db/repositories/user-role.repository.js";

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
    const roleNames: string[] = [];
    for (const rid of roleIds) {
      const r = await roleRepo.findById(rid);
      if (r) roleNames.push(r.name);
    }
    console.log(`  ${user.id}  ${user.name ?? "(unnamed)"}  status=${user.status}  roles=[${roleNames.join(", ")}]`);
  }
  closeDatabase();
}

export async function userCreateAction(opts: { name?: string; roleIds?: string[] }): Promise<void> {
  const { userRepo, userRoleRepo, roleRepo } = initRepos();
  const token = `sk-live-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const hash = sha256(token);
  const user = await userRepo.create({ name: opts.name, token: hash });
  if (opts.roleIds?.length) {
    await userRoleRepo.replaceUserRoles(user.id, opts.roleIds);
  }
  const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);
  console.log("User created:");
  console.log(`  ID:    ${user.id}`);
  console.log(`  Name:  ${user.name ?? "(unnamed)"}`);
  console.log(`  Token: ${token}`);
  console.log(`  Tags:  [${tags.join(", ")}]`);
  console.log("\n  ⚠ Save the token above — it cannot be retrieved again.");
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
  const roles: Array<{ id: string; name: string; tags: string[] }> = [];
  for (const rid of roleIds) {
    const r = await roleRepo.findById(rid);
    if (r) roles.push({ id: r.id, name: r.name, tags: r.tags });
  }
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
  const { userRepo, userRoleRepo, roleRepo } = initRepos();
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
