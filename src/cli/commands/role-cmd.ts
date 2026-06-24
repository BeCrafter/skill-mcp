import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { RoleRepository } from "../../db/repositories/role.repository.js";
import { UserRoleRepository } from "../../db/repositories/user-role.repository.js";
import { c, kv, table, section, ok, fail, warn, kvWidth, hint } from "../ui.js";
import { requireAuth, readCredentials } from "./auth-cmd.js";
import { getServerUrl, apiCall } from "../remote-client.js";
import { ConflictError } from "../../utils/errors.js";

function initRepos() {
  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  return {
    roleRepo: new RoleRepository(db),
    userRoleRepo: new UserRoleRepository(db),
  };
}

export async function roleListAction(opts: { serverUrl?: string } = {}): Promise<void> {
  requireAuth();
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const creds = readCredentials()!;
    const roles = await apiCall<Array<{ id: string; name: string; description: string | null; tags: string[] }>>(
      serverUrl, "GET", "/api/admin/roles", { credentials: creds },
    );
    if (!roles.length) { warn("No roles found."); return; }
    console.log(section("Roles", roles.length));
    console.log();
    const rows = roles.map(r => ({
      id: r.id, name: r.name, tags: (r.tags ?? []).join(", "), desc: r.description?.slice(0, 40) ?? "",
    }));
    console.log(table(rows, [
      { key: "id", header: "ID", width: 2, format: v => c.dim(String(v)) },
      { key: "name", header: "NAME", width: 16 },
      { key: "tags", header: "TAGS", width: 24 },
      { key: "desc", header: "DESCRIPTION", width: 42, format: v => v ? c.dim(String(v)) : "" },
    ]));
    console.log();
    return;
  }

  // Local mode
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
    id: r.id,
    name: r.name,
    tags: r.tags.join(", "),
    desc: r.description ? r.description.slice(0, 40) : "",
  }));

  console.log(table(rows, [
    { key: "id", header: "ID", width: 2, format: v => c.dim(String(v)) },
    { key: "name", header: "NAME", width: 16 },
    { key: "tags", header: "TAGS", width: 24 },
    { key: "desc", header: "DESCRIPTION", width: 42, format: v => v ? c.dim(String(v)) : "" },
  ]));

  console.log();
  closeDatabase();
}

export async function roleCreateAction(opts: { name: string; description?: string; tags: string[]; serverUrl?: string }): Promise<void> {
  requireAuth();
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const creds = readCredentials()!;
    try {
      const role = await apiCall<{ id: string; name: string; description: string | null; tags: string[] }>(
        serverUrl, "POST", "/api/admin/roles", { body: { name: opts.name, description: opts.description, tags: opts.tags }, credentials: creds },
      );
      ok(`Role created: ${c.bold(role.name)}`);
      console.log(kv("id", c.dim(role.id)));
      console.log(kv("tags", role.tags?.join(", ") || c.dim("(none)")));
    } catch (err) {
      if (err instanceof Error && (err instanceof ConflictError || err.message.includes("already exists"))) {
        fail(`Role "${opts.name}" already exists`);
      } else {
        throw err;
      }
    }
    return;
  }

  // Local mode
  const { roleRepo } = initRepos();
  try {
    const role = await roleRepo.create(opts);

    console.log(section("role created", undefined, kvWidth(12, c.dim(role.id), role.name, role.description ?? "(none)", role.tags.join(", "))));
    console.log();
    console.log(kv("id", c.dim(role.id)));
    console.log(kv("name", role.name));
    console.log(kv("description", role.description ?? c.dim("(none)")));
    console.log(kv("tags", role.tags.join(", ") || c.dim("(none)")));

    console.log();
  } catch (err) {
    if (err instanceof Error && (err instanceof ConflictError || err.message.includes("already exists"))) {
      fail(`Role "${opts.name}" already exists`);
    } else {
      throw err;
    }
  }
  closeDatabase();
}

export async function roleGetAction(roleId: string, opts: { serverUrl?: string } = {}): Promise<void> {
  requireAuth();
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const creds = readCredentials()!;
    const role = await apiCall<{ id: string; name: string; description: string | null; tags: string[] }>(
      serverUrl, "GET", `/api/admin/roles/${roleId}`, { credentials: creds },
    );
    console.log(section("role"));
    console.log();
    console.log(kv("id", c.dim(role.id)));
    console.log(kv("name", role.name));
    console.log(kv("description", role.description ?? c.dim("(none)")));
    console.log(kv("tags", role.tags?.join(", ") || c.dim("(none)")));
    console.log();
    return;
  }

  // Local mode
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

export async function roleUpdateAction(roleId: string, data: { name?: string; description?: string; tags?: string[]; serverUrl?: string }): Promise<void> {
  requireAuth();
  const serverUrl = getServerUrl(data);

  if (serverUrl) {
    const creds = readCredentials()!;
    const body: Record<string, unknown> = {};
    if (data.name) body.name = data.name;
    if (data.description) body.description = data.description;
    if (data.tags) body.tags = data.tags;
    const role = await apiCall<{ id: string; name: string; tags: string[] }>(
      serverUrl, "PUT", `/api/admin/roles/${roleId}`, { body, credentials: creds },
    );
    ok(`Role updated: ${c.bold(role.name)}`);
    return;
  }

  // Local mode
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

export async function roleDeleteAction(roleId: string, opts: { serverUrl?: string } = {}): Promise<void> {
  requireAuth();
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const creds = readCredentials()!;
    await apiCall(serverUrl, "DELETE", `/api/admin/roles/${roleId}`, { credentials: creds });
    ok(`${c.bold("Deleted")}  role  ${c.dim(roleId)}`);
    return;
  }

  // Local mode
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
