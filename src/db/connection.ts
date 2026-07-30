import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.js";

export type DrizzleDB = BetterSQLite3Database<typeof schema>;
let db: DrizzleDB | null = null;
let sqlite: Database.Database | null = null;
let currentPath: string | null = null;

function normalizeSqlitePath(input: string): string {
  if (!input || input.trim().length === 0) throw new Error("Database path is empty. Set DATABASE_PATH.");
  if (input.startsWith("sqlite://")) return input.slice("sqlite://".length);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    throw new Error("Only SQLite database paths are supported in v0.1. Set DATABASE_PATH.");
  }
  return input;
}

/** Open or reuse the configured SQLite database. */
export function getDatabase(input: string): DrizzleDB {
  const path = normalizeSqlitePath(input);
  if (db && currentPath === path) return db;
  closeDatabase();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  currentPath = path;
  db = drizzle(sqlite, { schema });
  return db;
}

export function createDatabase(dbPath: string): DrizzleDB {
  closeDatabase();
  return getDatabase(dbPath);
}

export function closeDatabase(): void {
  if (sqlite) {
    try { sqlite.close(); } catch { /* already closed */ }
  }
  sqlite = null;
  db = null;
  currentPath = null;
}
