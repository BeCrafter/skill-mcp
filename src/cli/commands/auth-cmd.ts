import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { c, kv, section, ok, warn, fail, hint } from "../ui.js";
import { verifyJwt } from "../../auth/jwt.service.js";

const CREDENTIALS_PATH = join(homedir(), ".skill-mcp", "credentials.json");

interface Credentials {
  userId: string;
  username: string;
  userType: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function readCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8")) as Credentials;
  } catch {
    return null;
  }
}

function saveCredentials(creds: Credentials): void {
  const dir = join(homedir(), ".skill-mcp");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function clearCredentials(): void {
  if (existsSync(CREDENTIALS_PATH)) {
    writeFileSync(CREDENTIALS_PATH, "", { mode: 0o600 });
  }
}

export async function loginAction(): Promise<void> {
  const { createInterface } = await import("node:readline");

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => { rl.question(prompt, (answer) => resolve(answer)); });

  const username = await question("Username: ");
  const password = await question("Password: ");
  rl.close();
  // newline after password input
  process.stderr.write("\n");

  const config = getConfig();
  const port = config.transport.port;
  const host = config.transport.host;

  const res = await fetch(`http://${host}:${port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    fail(`Login failed: ${body.error ?? res.statusText}`);
    process.exit(1);
  }

  const body = await res.json() as { data: { access_token: string; refresh_token: string; expires_in: number; user: { id: string; username: string; user_type: string } } };
  const { access_token, refresh_token, expires_in, user } = body.data;

  saveCredentials({
    userId: user.id,
    username: user.username,
    userType: user.user_type,
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt: Date.now() + expires_in * 1000,
  });

  ok(`Logged in as ${c.bold(user.username)} (${user.user_type})`);
}

export async function logoutAction(): Promise<void> {
  clearCredentials();
  ok("Logged out");
}

export async function whoamiAction(): Promise<void> {
  const creds = readCredentials();
  if (!creds) {
    warn("Not logged in. Run `skill-mcp auth login` first.");
    return;
  }

  // Check if token is expired
  const expired = creds.expiresAt < Date.now();
  const config = getConfig();
  const jwtIssuer = config.auth?.jwt?.issuer ?? "skill-mcp";

  let username = creds.username;
  let userType = creds.userType;

  // Try to read from JWT if not expired
  if (!expired) {
    try {
      const payload = verifyJwt(creds.accessToken, config.auth?.jwt?.secret ?? "", jwtIssuer);
      username = payload.username ?? username;
      userType = payload.user_type ?? userType;
    } catch {
      // ignore
    }
  }

  console.log(section("Current user"));
  console.log();
  console.log(kv("userId", creds.userId));
  console.log(kv("username", username));
  console.log(kv("userType", userType));
  console.log(kv("expires", new Date(creds.expiresAt).toISOString()));
  console.log(kv("status", expired ? c.boldRed("EXPIRED") : c.boldGreen("VALID")));

  if (expired) {
    hint("Token expired. Run `skill-mcp auth login` to re-authenticate.");
  }

  console.log();
}

export async function resetPasswordAction(opts: { username: string; password: string }): Promise<void> {
  if (opts.password.length < 8) {
    fail("Password must be at least 8 characters");
    process.exit(1);
  }

  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  const userRepo = new UserRepository(db);

  const user = await userRepo.findByUsername(opts.username);
  if (!user) {
    fail(`User not found: ${opts.username}`);
    closeDatabase();
    process.exit(1);
  }

  if (user.userType !== "superadmin" && user.userType !== "admin") {
    fail(`User "${opts.username}" is not an admin (user_type=${user.userType}). Only admin/superadmin users can reset passwords.`);
    closeDatabase();
    process.exit(1);
  }

  const { hashSync } = await import("bcryptjs");
  await userRepo.updatePassword(user.id, hashSync(opts.password, 12));

  ok(`Password reset for ${c.bold(opts.username)} (${user.userType})`);
  closeDatabase();
}
