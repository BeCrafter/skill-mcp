import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { UserRepository } from "../../db/repositories/user.repository.js";
import { UserRoleRepository } from "../../db/repositories/user-role.repository.js";
import { c, kv, section, ok, warn, fail, hint } from "../ui.js";
import { signAccessToken, signRefreshToken, verifyJwt } from "../../auth/jwt.service.js";
import { getServerUrl, apiCall } from "../remote-client.js";

const CREDENTIALS_PATH = join(homedir(), ".skill-mcp", "credentials.json");

export interface Credentials {
  userId: string;
  username: string;
  userType: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export function readCredentials(): Credentials | null {
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

export async function loginAction(opts: { serverUrl?: string } = {}): Promise<void> {
  const { createInterface } = await import("node:readline");

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => { rl.question(prompt, (answer) => resolve(answer)); });

  const username = await question("Username: ");

  // Password input with masking (no echo)
  rl.close();
  process.stderr.write("Password: ");
  const password = await readPassword();
  process.stderr.write("\n");

  const serverUrl = getServerUrl(opts);
  if (serverUrl) {
    await loginViaHttp(serverUrl, username, password);
  } else {
    await loginViaLocal(username, password);
  }
}

/** Read password from stdin with masked output (prints * for each character) */
function readPassword(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding("utf-8");

    let password = "";

    const onData = (char: string) => {
      if (char === "\n" || char === "\r" || char === "") {
        // Enter or Ctrl+D — finish
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener("data", onData);
        resolve(password);
      } else if (char === "") {
        // Ctrl+C — abort
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.exit(130);
      } else if (char === "" || char === "\b") {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stderr.write("\b \b");
        }
      } else {
        password += char;
        process.stderr.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

/** Local mode: verify password against local DB, sign JWT locally */
async function loginViaLocal(username: string, password: string): Promise<void> {
  const config = getConfig();
  const jwtSecret = config.auth?.jwt?.secret;
  if (!jwtSecret) {
    fail("JWT secret not found", "Run: skill-mcp init first, or set AUTH_JWT_SECRET");
    process.exit(1);
  }

  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  const userRepo = new UserRepository(db);
  const userRoleRepo = new UserRoleRepository(db);

  const user = await userRepo.findByUsername(username);
  if (!user || (user.userType !== "admin" && user.userType !== "superadmin")) {
    fail("Invalid credentials");
    closeDatabase();
    process.exit(1);
  }

  if (user.status !== "active" || !user.passwordHash) {
    fail("Invalid credentials");
    closeDatabase();
    process.exit(1);
  }

  const { compare } = await import("bcryptjs");
  if (!(await compare(password, user.passwordHash))) {
    fail("Invalid credentials");
    closeDatabase();
    process.exit(1);
  }

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

  saveCredentials({
    userId: user.id, username: user.username ?? "", userType: user.userType,
    accessToken, refreshToken, expiresAt: Date.now() + accessExpiresIn * 1000,
  });

  ok(`Logged in as ${c.bold(user.username ?? username)} (${user.userType})`);
  closeDatabase();
}

/** Remote mode: HTTP request to server */
async function loginViaHttp(serverUrl: string, username: string, password: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    fail(`Connection failed: ${serverUrl}`, "Is the server running?");
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    if (res.status === 404) {
      fail("Auth endpoint not found", "Is the server running with AUTH_JWT_SECRET configured?");
    } else {
      fail(`Login failed: ${body.error ?? res.statusText}`);
    }
    process.exit(1);
  }

  const body = await res.json() as { data: { access_token: string; refresh_token: string; expires_in: number; user: { id: string; username: string; user_type: string } } };
  const { access_token, refresh_token, expires_in, user } = body.data;

  saveCredentials({
    userId: user.id, username: user.username, userType: user.user_type,
    accessToken: access_token, refreshToken: refresh_token,
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
      const payload = await verifyJwt(creds.accessToken, config.auth?.jwt?.secret ?? "", jwtIssuer);
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

export function requireAuth(): Credentials {
  const creds = readCredentials();
  if (!creds) {
    fail("Not logged in. Run `skill-mcp auth login` first.");
    process.exit(1);
  }
  if (creds.expiresAt < Date.now()) {
    fail("Token expired. Run `skill-mcp auth login` to re-authenticate.");
    process.exit(1);
  }
  return creds;
}

export async function resetPasswordAction(opts: { username: string; password: string; serverUrl?: string }): Promise<void> {
  requireAuth();
  if (opts.password.length < 8) {
    fail("Password must be at least 8 characters");
    process.exit(1);
  }

  const serverUrl = getServerUrl(opts);
  const creds = readCredentials()!;

  if (serverUrl) {
    await apiCall(serverUrl, "POST", `/api/admin/users/${opts.username}/reset-password`, {
      body: { new_password: opts.password },
      credentials: creds,
    });
    ok(`Password reset for ${c.bold(opts.username)}`);
    return;
  }

  // Local mode
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

  // Permission check: cannot reset superadmin password unless you are superadmin
  if (user.userType === "superadmin" && creds.userType !== "superadmin") {
    fail("Only superadmin can reset superadmin password");
    closeDatabase();
    process.exit(1);
  }

  const { hashSync } = await import("bcryptjs");
  await userRepo.updatePassword(user.id, hashSync(opts.password, 12));

  ok(`Password reset for ${c.bold(opts.username)} (${user.userType})`);
  closeDatabase();
}
