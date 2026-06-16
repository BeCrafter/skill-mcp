import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { RoleRepository } from "../../db/repositories/role.repository.js";
import { UserRoleRepository } from "../../db/repositories/user-role.repository.js";
import { c, kv, table, section, ok, fail, warn, kvWidth, hint } from "../ui.js";

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
    warn("No roles found.");
    closeDatabase();
    return;
  }

  console.log(section("Roles", roles.length));
  console.log();

  const rows = roles.map(r => ({
    id: c.dim(r.id),
    name: r.name,
    tags: r.tags.join(", "),
    desc: r.description ? c.dim(r.description.slice(0, 40)) : "",
  }));

  console.log(table(rows, [
    { key: "id", header: "ID", width: 2 },
    { key: "name", header: "NAME", width: 16 },
    { key: "tags", header: "TAGS", width: 24 },
    { key: "desc", header: "DESCRIPTION", width: 42 },
  ]));

  console.log();
  closeDatabase();
}

export async function roleCreateAction(opts: { name: string; description?: string; tags: string[] }): Promise<void> {
  const { roleRepo } = initRepos();
  const role = await roleRepo.create(opts);

    console.log(section("role created", undefined, kvWidth(12, c.dim(role.id), role.name, role.description ?? "(none)", role.tags.join(", "))));
    console.log();
    console.log(kv("id", c.dim(role.id)));
    console.log(kv("name", role.name));
    console.log(kv("description", role.description ?? c.dim("(none)")));
    console.log(kv("tags", role.tags.join(", ") || c.dim("(none)")));

  console.log();
  closeDatabase();
}

export async function roleGetAction(roleId: string): Promise<void> {
  const { roleRepo } = initRepos();
  const role = await roleRepo.findById(roleId);
  if (!role) {
    fail(`Role not found: ${roleId}`, "Use `skill-mcp role list` to see available roles");
    closeDatabase();
    process.exit(1);
  }

    console.log(section("role", undefined, kvWidth(12, c.dim(role.id), role.name, role.description ?? "(none)", role.tags.join(", "))));
    console.log();
    console.log(kv("id", c.dim(role.id)));
    console.log(kv("name", role.name));
    console.log(kv("description", role.description ?? c.dim("(none)")));
    console.log(kv("tags", role.tags.join(", ") || c.dim("(none)")));

  console.log();
  closeDatabase();
}

export async function roleUpdateAction(roleId: string, data: { name?: string; description?: string; tags?: string[] }): Promise<void> {
  const { roleRepo } = initRepos();
  const updated = await roleRepo.update(roleId, data);
  if (!updated) {
    fail(`Role not found: ${roleId}`, "Use `skill-mcp role list` to see available roles");
    closeDatabase();
    process.exit(1);
  }

    console.log(section("role updated", undefined, kvWidth(12, c.dim(updated.id), updated.name, updated.tags.join(", "))));
    console.log();
    console.log(kv("id", c.dim(updated.id)));
    console.log(kv("name", updated.name));
    console.log(kv("tags", updated.tags.join(", ") || c.dim("(none)")));

  console.log();
  closeDatabase();
}

export async function roleDeleteAction(roleId: string): Promise<void> {
  const { roleRepo, userRoleRepo } = initRepos();
  await userRoleRepo.deleteByRoleId(roleId);
  const deleted = await roleRepo.delete(roleId);
  if (!deleted) {
    fail(`Role not found: ${roleId}`, "Use `skill-mcp role list` to see available roles");
    closeDatabase();
    process.exit(1);
  }
  ok(`${c.bold("Deleted")}  role  ${c.dim(roleId)}`);
  hint("Run `skill-mcp role list` to see remaining roles");
  closeDatabase();
}
