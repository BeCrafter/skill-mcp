import { generateToken } from "../../utils/id.js";
import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { RoleRepository } from "../../db/repositories/role.repository.js";
import { UserRoleRepository } from "../../db/repositories/user-role.repository.js";
import { c, kv, section, ok, fail, warn } from "../ui.js";
import { sha256 } from "../../utils/crypto.js";

export async function initAction(opts: { username: string; password: string }): Promise<void> {
  if (opts.password.length < 8) {
    fail("Password must be at least 8 characters");
    process.exit(1);
  }

  const config = getConfig();
  if (!config.auth?.jwt?.secret) {
    warn("AUTH_JWT_SECRET not configured. JWT login will not be available.");
    warn("Set AUTH_JWT_SECRET env var to enable JWT authentication.");
  }

  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  const userRepo = new UserRepository(db);
  const roleRepo = new RoleRepository(db);
  const userRoleRepo = new UserRoleRepository(db);

  // Check if any users exist — init only allowed on empty DB
  const existingUsers = await userRepo.findAll();
  if (existingUsers.length > 0) {
    fail("Database already contains users. Init is only for first-time setup.");
    closeDatabase();
    process.exit(1);
  }

  const { hashSync } = await import("bcryptjs");

  // Create superadmin user
  const token = generateToken();
  const hash = sha256(token);
  const passwordHash = hashSync(opts.password, 12);

  const user = await userRepo.create({
    name: "System Admin",
    username: opts.username,
    passwordHash,
    userType: "superadmin",
    token: hash,
  });

  // Create superadmin role with broad tags
  let superadminRole;
  try {
    superadminRole = await roleRepo.create({
      name: "superadmin",
      description: "Superadmin role with full access",
      tags: ["all-skills"],
    });
  } catch {
    // Role may already exist from previous partial init
    const roles = await roleRepo.findAll();
    superadminRole = roles.find(r => r.name === "superadmin");
  }

  if (superadminRole) {
    await userRoleRepo.replaceUserRoles(user.id, [superadminRole.id]);
  }

  console.log(section("System initialized", undefined, 20));
  console.log();
  console.log(kv("userId", c.dim(user.id)));
  console.log(kv("username", c.bold(opts.username)));
  console.log(kv("userType", c.boldGreen("superadmin")));
  console.log(kv("token", c.boldYellow(token)));
  console.log();
  ok(`Superadmin '${opts.username}' created successfully.`);
  warn("Save the token above — it cannot be retrieved again.");
  console.log();
  closeDatabase();
}
