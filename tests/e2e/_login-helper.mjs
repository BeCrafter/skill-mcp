#!/usr/bin/env node
/**
 * 非交互式登录辅助脚本
 * 用法:
 *   node tests/e2e/_login-helper.mjs login <username> <password>
 *   node tests/e2e/_login-helper.mjs reset-and-login <username> <password>
 * 
 * reset-and-login: 先重置密码再登录（绕过未知密码）
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CREDENTIALS_PATH = join(homedir(), ".skill-mcp", "credentials.json");

async function main() {
  const [,, action, username, password] = process.argv;
  
  if (!action || !username || !password) {
    console.error("用法:");
    console.error("  node _login-helper.mjs login <username> <password>");
    console.error("  node _login-helper.mjs reset-and-login <username> <password>");
    process.exit(1);
  }

  const { getConfig } = await import("../../dist/config/index.js");
  const { runMigrations } = await import("../../dist/db/migrate.js");
  const { getDatabase, closeDatabase } = await import("../../dist/db/connection.js");
  const { UserRepository } = await import("../../dist/db/repositories/user.repository.js");
  const { UserRoleRepository } = await import("../../dist/db/repositories/user-role.repository.js");
  const { hash: hashPassword, compare } = await import("bcryptjs");
  
  const config = getConfig();
  const jwtSecret = config.auth?.jwt?.secret;
  if (!jwtSecret) {
    console.error("✗ JWT secret not found. Run: skill-mcp init first");
    process.exit(1);
  }

  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  const userRepo = new UserRepository(db);
  const userRoleRepo = new UserRoleRepository(db);

  let user = await userRepo.findByUsername(username);

  // reset-and-login: 重置密码
  if (action === "reset-and-login") {
    if (!user) {
      console.error(`✗ User not found: ${username}`);
      closeDatabase();
      process.exit(1);
    }
    const newHash = await hashPassword(password, 12);
    const { sql } = await import("drizzle-orm");
    db.run(sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${user.id}`);
    console.log(`✓ Password reset for ${username}`);
  }

  // 重新获取用户（确保数据最新）
  user = await userRepo.findByUsername(username);
  if (!user) {
    console.error(`✗ User not found: ${username}`);
    closeDatabase();
    process.exit(1);
  }

  if (user.status !== "active" || !user.passwordHash) {
    console.error("✗ Invalid credentials (user inactive or no password)");
    closeDatabase();
    process.exit(1);
  }

  if (!(await compare(password, user.passwordHash))) {
    console.error("✗ Invalid credentials (wrong password)");
    closeDatabase();
    process.exit(1);
  }

  const { signAccessToken, signRefreshToken } = await import("../../dist/auth/jwt.service.js");
  
  const tags = await userRoleRepo.getAggregatedTagsByUserId(user.id);
  const jwtIssuer = config.auth?.jwt?.issuer ?? "skill-mcp";
  const accessExpiresIn = config.auth?.jwt?.accessExpiresIn ?? 7200;
  const refreshExpiresIn = config.auth?.jwt?.refreshExpiresIn ?? 604800;

  const accessToken = await signAccessToken({
    userId: user.id, username: user.username ?? "", userType: user.userType,
    tags, secret: jwtSecret, expiresInSec: accessExpiresIn, issuer: jwtIssuer,
  });
  const refreshToken = await signRefreshToken({
    userId: user.id, secret: jwtSecret, expiresInSec: refreshExpiresIn, issuer: jwtIssuer,
  });

  // 保存凭证
  const dir = join(homedir(), ".skill-mcp");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify({
    userId: user.id,
    username: user.username ?? "",
    userType: user.userType,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + accessExpiresIn * 1000,
  }, null, 2), { mode: 0o600 });

  console.log(`✓ Logged in as ${user.username} (${user.userType})`);
  closeDatabase();
}

main().catch(err => {
  console.error("✗ Login failed:", err.message);
  process.exit(1);
});
