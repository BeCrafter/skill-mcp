import { generateToken } from "../../utils/id.js";
import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { RoleRepository } from "../../db/repositories/role.repository.js";
import { UserRoleRepository } from "../../db/repositories/user-role.repository.js";
import { c, kv, section, ok, fail, hint } from "../ui.js";
import { sha256 } from "../../utils/crypto.js";
import { saveLocalConfig } from "../local-config.js";
import { randomBytes } from "node:crypto";

export async function initAction(opts: { username: string; password: string }): Promise<void> {
  if (opts.password.length < 8) {
    fail("Password must be at least 8 characters");
    process.exit(1);
  }

  const config = getConfig();

  // Auto-generate JWT secret if not configured
  if (!config.auth?.jwt?.secret) {
    const secret = randomBytes(32).toString("base64");
    saveLocalConfig({ jwt_secret: secret });
    process.env.AUTH_JWT_SECRET = secret;
    ok(`JWT secret auto-generated and saved to ~/.skill-mcp/config.json`);
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

  // Create default roles: superadmin, admin, user
  let superadminRole;
  try {
    superadminRole = await roleRepo.create({
      name: "superadmin",
      description: "Superadmin role with full access",
      tags: ["all-skills"],
    });
  } catch {
    const roles = await roleRepo.findAll();
    superadminRole = roles.find(r => r.name === "superadmin");
  }

  try {
    await roleRepo.create({
      name: "admin",
      description: "Admin role with full skill access",
      tags: ["all-skills"],
    });
  } catch {
    // Role may already exist
  }

  try {
    await roleRepo.create({
      name: "user",
      description: "Default user role",
      tags: [],
    });
  } catch {
    // Role may already exist
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
  hint(`Use ${c.cyan("skill-mcp user get <userId>")} to view token later.`);
  console.log();
  closeDatabase();
}
