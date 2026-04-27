import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { RoleRepository } from "../../db/repositories/role.repository.js";
import { UserRoleRepository } from "../../db/repositories/user-role.repository.js";

function initRepos() {
  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  return {
    roleRepo: new RoleRepository(db),
    userRoleRepo: new UserRoleRepository(db),
  };
}

export async function roleListAction(): Promise<void> {
  const { roleRepo } = initRepos();
  const roles = await roleRepo.findAll();
  if (roles.length === 0) {
    console.log("No roles found.");
    closeDatabase();
    return;
  }
  for (const role of roles) {
    console.log(`  ${role.id}  ${role.name}  tags=[${role.tags.join(", ")}]  ${role.description ?? ""}`);
  }
  closeDatabase();
}

export async function roleCreateAction(opts: { name: string; description?: string; tags: string[] }): Promise<void> {
  const { roleRepo } = initRepos();
  const role = await roleRepo.create(opts);
  console.log("Role created:");
  console.log(`  ID:          ${role.id}`);
  console.log(`  Name:        ${role.name}`);
  console.log(`  Description: ${role.description ?? "(none)"}`);
  console.log(`  Tags:        [${role.tags.join(", ")}]`);
  closeDatabase();
}

export async function roleGetAction(roleId: string): Promise<void> {
  const { roleRepo } = initRepos();
  const role = await roleRepo.findById(roleId);
  if (!role) {
    console.error(`Role not found: ${roleId}`);
    closeDatabase();
    process.exit(1);
  }
  console.log(`Role: ${role.id}`);
  console.log(`  Name:        ${role.name}`);
  console.log(`  Description: ${role.description ?? "(none)"}`);
  console.log(`  Tags:        [${role.tags.join(", ")}]`);
  closeDatabase();
}

export async function roleUpdateAction(roleId: string, data: { name?: string; description?: string; tags?: string[] }): Promise<void> {
  const { roleRepo } = initRepos();
  const updated = await roleRepo.update(roleId, data);
  if (!updated) {
    console.error(`Role not found: ${roleId}`);
    closeDatabase();
    process.exit(1);
  }
  console.log(`Role ${roleId} updated.`);
  console.log(`  Name:        ${updated.name}`);
  console.log(`  Tags:        [${updated.tags.join(", ")}]`);
  closeDatabase();
}

export async function roleDeleteAction(roleId: string): Promise<void> {
  const { roleRepo, userRoleRepo } = initRepos();
  await userRoleRepo.deleteByRoleId(roleId);
  const deleted = await roleRepo.delete(roleId);
  if (!deleted) {
    console.error(`Role not found: ${roleId}`);
    closeDatabase();
    process.exit(1);
  }
  console.log(`Role ${roleId} deleted.`);
  closeDatabase();
}
