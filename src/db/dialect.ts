// P0-8 — Database dialect resolution.
//
// The codebase historically assumed SQLite via better-sqlite3. The
// commercialization review (§3.1) requires a Postgres path for enterprise
// deployments. This module is the *single* place that decides which driver to
// load and parses the user's `DATABASE_URL` / `DATABASE_PATH` config.
//
// Scope of P0-8 (this commit):
//   - URL parser + dialect tag                   (this file)
//   - Connection factory with lazy driver import (connection.ts)
//   - `migrate:check` CLI for compat scanning    (cli/commands/migrate-cmd.ts)
//   - SQLite remains the primary tested path; PG schema port and dual
//     migrations are tracked as P1 (see review §3.1.1 6-week playbook).

export type DbDialect = "sqlite" | "postgres";

export interface DialectConfig {
  dialect: DbDialect;
  /** Filesystem path for sqlite; undefined for postgres. */
  path?: string;
  /** Connection URL for postgres; undefined for sqlite. */
  url?: string;
}

/**
 * Resolve a `DialectConfig` from user input. Accepts:
 *   - `sqlite:///abs/path/to.db` (RFC-style, three slashes for absolute path)
 *   - `sqlite://./relative.db`   (two slashes, host = ".", path = "/relative.db")
 *   - `postgres://user:pass@host:5432/db` / `postgresql://...`
 *   - bare filesystem path (`./data/skill-mcp.db`) — treated as sqlite for
 *     backward compatibility with `DATABASE_PATH`.
 *
 * Throws on unsupported schemes (mysql, mongodb, …) so misconfiguration fails
 * loudly rather than silently picking the wrong driver.
 */
export function parseDatabaseUrl(input: string): DialectConfig {
  if (!input || input.trim().length === 0) {
    throw new Error("Database URL/path is empty. Set DATABASE_URL or DATABASE_PATH.");
  }

  const trimmed = input.trim();

  // No scheme → bare path (legacy DATABASE_PATH).
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { dialect: "sqlite", path: trimmed };
  }

  if (trimmed.startsWith("sqlite://")) {
    // Drop scheme; preserve the path. We support both `sqlite:///abs` and
    // `sqlite://relative` shapes — drizzle/better-sqlite3 only need the path.
    const afterScheme = trimmed.slice("sqlite://".length);
    // `sqlite:///foo.db` → "/foo.db" (absolute), `sqlite://./foo.db` → "./foo.db"
    const path = afterScheme.startsWith("/") && !afterScheme.startsWith("//")
      ? afterScheme
      : afterScheme;
    if (!path) throw new Error(`Invalid sqlite:// URL: missing path in "${trimmed}"`);
    return { dialect: "sqlite", path };
  }

  if (trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://")) {
    return { dialect: "postgres", url: trimmed };
  }

  throw new Error(
    `Unsupported database scheme in "${trimmed}". Supported: sqlite:// (or bare path), postgres://, postgresql://.`,
  );
}

/**
 * Resolve the active dialect from environment + config. Precedence:
 *   1. `DATABASE_URL` env var (if set, wins — explicit user intent)
 *   2. Config-provided `database.path` (legacy; treated as sqlite path)
 *
 * Centralizing this keeps the precedence rule out of CLI / app bootstrap.
 */
export function resolveDialect(opts: { databaseUrl?: string; databasePath?: string }): DialectConfig {
  if (opts.databaseUrl && opts.databaseUrl.trim().length > 0) {
    return parseDatabaseUrl(opts.databaseUrl);
  }
  if (opts.databasePath && opts.databasePath.trim().length > 0) {
    return parseDatabaseUrl(opts.databasePath);
  }
  throw new Error("Neither DATABASE_URL nor DATABASE_PATH is set.");
}
