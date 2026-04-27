import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.js";

export type DrizzleDB = BetterSQLite3Database<typeof schema>;

let _db: DrizzleDB | null = null;
let _sqlite: Database.Database | null = null;
let _currentPath: string | null = null;

export function getDatabase(dbPath: string): DrizzleDB {
  if (_db && _currentPath === dbPath) return _db;

  closeDatabase();

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");

  _currentPath = dbPath;
  _db = drizzle(_sqlite, { schema });
  return _db;
}

export function createDatabase(dbPath: string): DrizzleDB {
  closeDatabase();
  return getDatabase(dbPath);
}

export function closeDatabase(): void {
  if (_sqlite) {
    try { _sqlite.close(); } catch {}
    _sqlite = null;
  }
  _db = null;
  _currentPath = null;
}
