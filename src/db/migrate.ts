import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the packaged Drizzle migration folder. */
function resolveMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (let dir = here, i = 0; i < 6; i += 1, dir = dirname(dir)) {
    const candidate = join(dir, "drizzle");
    if (existsSync(join(candidate, "meta", "_journal.json"))) return candidate;
  }
  return resolve(process.cwd(), "drizzle");
}

/**
 * This release deliberately never reconstructs a pre-Drizzle database.
 * The former baseline bootstrap path dropped every application table, which
 * could silently destroy real skills, users, roles, and version history.
 *
 * An untracked, non-empty database therefore fails closed. Operators must
 * back it up and migrate it with an explicit, reviewed migration tool; fresh
 * databases and databases already tracked by Drizzle remain supported.
 */
function assertSafeMigrationState(sqlite: Database.Database): void {
  const migrationTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (migrationTable) return;

  const existingTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .get() as { name?: string } | undefined;
  if (existingTable) {
    throw new Error(
      `Refusing to migrate untracked legacy database containing table "${existingTable.name}". ` +
      "No data was changed. Back up the database and use an explicit in-place migration before starting v0.1.",
    );
  }
}

/** Run the immutable SQLite migration history without destructive recovery. */
export function runMigrations(dbPath: string): void {
  if (!dbPath || dbPath.trim().length === 0) {
    throw new Error("Database path is empty. Set DATABASE_PATH.");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(dbPath) && !dbPath.startsWith("sqlite://")) {
    throw new Error("Only SQLite database paths are supported in v0.1. Set DATABASE_PATH.");
  }
  const resolvedPath = dbPath.startsWith("sqlite://") ? dbPath.slice("sqlite://".length) : dbPath;
  if (!resolvedPath) throw new Error("Invalid sqlite:// URL: missing database path.");

  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sqlite = new Database(resolvedPath);
  try {
    sqlite.pragma("journal_mode = WAL");
    assertSafeMigrationState(sqlite);
    sqlite.pragma("foreign_keys = OFF");
    const db = drizzle(sqlite);
    // Dynamic import preserves direct invocation from compiled dist.
    void db;
    const { migrate } = requireMigration();
    migrate(db, { migrationsFolder: resolveMigrationsFolder() });
    sqlite.pragma("foreign_keys = ON");
  } finally {
    sqlite.close();
  }
}

function requireMigration(): { migrate: typeof import("drizzle-orm/better-sqlite3/migrator").migrate } {
  // ESM static import is intentionally avoided only to keep this helper's
  // return type narrow; this has no runtime configurability.
  return { migrate: (awaitlessMigrate as typeof import("drizzle-orm/better-sqlite3/migrator").migrate) };
}

import { migrate as awaitlessMigrate } from "drizzle-orm/better-sqlite3/migrator";
