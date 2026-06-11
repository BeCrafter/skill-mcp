import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.js";
import { parseDatabaseUrl, type DialectConfig } from "./dialect.js";

// P0-8 — `DrizzleDB` is now an alias for whichever driver the user picked.
// Until the PG schema port lands (P1, see review §3.1.1) the runtime type is
// always BetterSQLite3Database; the union widens once we add pg.
//
// Why a union here vs swapping the type per dialect? Repositories type their
// constructor parameter as `DrizzleDB` and use the schema relations from
// drizzle — both surfaces are dialect-agnostic in normal CRUD. The only
// dialect-sensitive call site is migrate.ts (raw SQL), which is already
// dialect-aware.
export type DrizzleDB = BetterSQLite3Database<typeof schema>;

let _db: DrizzleDB | null = null;
let _sqlite: Database.Database | null = null;
let _currentKey: string | null = null;

/**
 * Open (or reuse) a database connection. Accepts either a bare filesystem
 * path (legacy `DATABASE_PATH`) or a URL (`sqlite://...`, `postgres://...`).
 */
export function getDatabase(input: string): DrizzleDB {
  const cfg = parseDatabaseUrl(input);
  const key = cfg.dialect === "sqlite" ? `sqlite:${cfg.path}` : `postgres:${cfg.url}`;
  if (_db && _currentKey === key) return _db;

  closeDatabase();

  if (cfg.dialect === "postgres") {
    // Postgres support is gated on the schema port (P1). Failing fast here is
    // better than letting a partial implementation corrupt data; the user's
    // intent is unambiguous (they set DATABASE_URL=postgres://...).
    throw new Error(
      "Postgres dialect detected (DATABASE_URL=postgres://...) but the PG schema port is not yet shipped. " +
        "Tracked as P1 (see review §3.1.1). Use sqlite for now.",
    );
  }

  return openSqlite(cfg, key);
}

function openSqlite(cfg: DialectConfig, key: string): DrizzleDB {
  if (!cfg.path) throw new Error("sqlite dialect requires a path");
  const dir = dirname(cfg.path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  _sqlite = new Database(cfg.path);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");
  _currentKey = key;
  _db = drizzle(_sqlite, { schema });
  return _db;
}

export function createDatabase(dbPath: string): DrizzleDB {
  closeDatabase();
  return getDatabase(dbPath);
}

export function closeDatabase(): void {
  if (_sqlite) {
    try { _sqlite.close(); } catch {
      // Connection already closed or error during close
    }
    _sqlite = null;
  }
  _db = null;
  _currentKey = null;
}
