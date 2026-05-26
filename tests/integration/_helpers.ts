import Database from "better-sqlite3";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Build dist/ once if it's missing. Tests that spawn `node dist/index.js`
 * call this in beforeAll. Ten-minute timeout is generous; first build takes
 * ~5-10s, subsequent calls no-op.
 */
export function ensureDistBuilt(): void {
  if (existsSync(DIST_ENTRY)) return;
  execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit", timeout: 600_000 });
}

/** Reserve and immediately release an unused TCP port so spawned servers don't collide. */
export async function getFreePort(): Promise<number> {
  return new Promise<number>((resolveP, rejectP) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectP);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        rejectP(new Error("Failed to obtain port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolveP(port));
    });
  });
}

export interface SeededRbac {
  userId: string;
  roleId: string;
  /** Plaintext token — place in `Authorization: Bearer ${token}`. */
  token: string;
  /** sha256(token) — what gets stored in DB. */
  tokenHash: string;
}

/**
 * Run migrations and pre-populate users/roles/user_roles for the given DB
 * path. Returns the plaintext token so callers can pass it into spawned
 * processes (`SKILL_MCP_AUTH_TOKEN=`) or HTTP requests.
 */
export function seedRbac(dbPath: string, opts: { tags?: string[]; tokenLabel?: string } = {}): SeededRbac {
  runMigrations(dbPath);
  const sqlite = new Database(dbPath);
  sqlite.pragma("foreign_keys = ON");

  const token = opts.tokenLabel ?? `tok-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const tokenHash = sha256(token);
  const userId = randomUUID();
  const roleId = randomUUID();
  const now = Date.now();
  const tags = JSON.stringify(opts.tags ?? []);

  sqlite.prepare(
    `INSERT INTO users (id, name, token, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, `test-user-${userId.slice(0, 8)}`, tokenHash, "active", now, now);

  sqlite.prepare(
    `INSERT INTO roles (id, name, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(roleId, `test-role-${roleId.slice(0, 8)}`, tags, now, now);

  sqlite.prepare(
    `INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)`,
  ).run(randomUUID(), userId, roleId, now);

  sqlite.close();
  return { userId, roleId, token, tokenHash };
}

/** Seed a `visibility=public` skill row directly so it shows up in list APIs. */
export function seedPublicSkill(dbPath: string, slug: string): string {
  const sqlite = new Database(dbPath);
  const id = randomUUID();
  const now = Date.now();
  sqlite.prepare(
    `INSERT INTO skills (id, slug, name, description, version, status, visibility, attributes, entry_file, storage_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, slug, slug, "test", "1.0.0", "published", "public", "{}", "SKILL.md", `${slug}/`, now, now);
  sqlite.close();
  return id;
}

/** Drop a SKILL.md + manifest.json onto disk for a given slug. */
export function writeSkillPackage(storageBase: string, slug: string, body = "# Test"): void {
  const dir = join(storageBase, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: slug, version: "1.0.0", entry: "SKILL.md" }));
}

export interface SpawnedServer {
  process: ChildProcess;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

export interface SpawnHttpOpts {
  port: number;
  env: NodeJS.ProcessEnv;
  /** ms to wait for "MCP Server started" before failing. Default 20000. */
  readyTimeoutMs?: number;
}

/**
 * Spawn `node dist/index.js serve --transport http --port <port>` with the
 * given env, wait for the "MCP Server started" log line, return a handle
 * with a stop() that kills + waits for exit.
 */
export async function spawnHttpServer(opts: SpawnHttpOpts): Promise<SpawnedServer> {
  const { port, env, readyTimeoutMs = 20_000 } = opts;
  const proc = spawn(
    "node",
    [DIST_ENTRY, "serve", "--transport", "http", "--port", String(port), "--host", "127.0.0.1"],
    { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );

  let buffer = "";
  const collected: string[] = [];
  const debug = process.env.SCENARIO_DEBUG === "1";
  const onData = (chunk: Buffer) => {
    const s = chunk.toString();
    buffer += s;
    collected.push(s);
    if (debug) process.stderr.write(`[${env.DEPLOYMENT_MODE ?? "?"}:${port}] ${s}`);
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);

  await new Promise<void>((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      rejectP(new Error(`Server did not become ready within ${readyTimeoutMs}ms.\nlogs:\n${collected.join("")}`));
    }, readyTimeoutMs);

    const check = setInterval(() => {
      if (buffer.includes("MCP Server started")) {
        clearInterval(check);
        clearTimeout(timer);
        resolveP();
      }
    }, 100);

    proc.once("exit", (code) => {
      clearInterval(check);
      clearTimeout(timer);
      rejectP(new Error(`Server exited (code=${code}) before ready.\nlogs:\n${collected.join("")}`));
    });
  });

  return {
    process: proc,
    port,
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      if (proc.exitCode !== null) return;
      proc.kill("SIGTERM");
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGKILL");
          r();
        }, 5_000);
        proc.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    },
  };
}
