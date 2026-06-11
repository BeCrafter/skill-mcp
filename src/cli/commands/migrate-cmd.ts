import { getConfig } from "../../config/index.js";
import { parseDatabaseUrl } from "../../db/dialect.js";
import { c } from "../ui.js";

// P0-8 — `skill-mcp migrate:check` is the first prerequisite tool from the
// review's §3.1.1 SQLite → Postgres playbook (Stage 0 pre-flight). It scans
// the *target* dialect URL and reports compatibility risks before the operator
// commits to a multi-week migration. We do this without touching the live DB:
// the inspection is purely on the URL/config, plus a list of known SQLite
// idioms in our schema that don't directly translate to PG.
//
// This is intentionally read-only: no DDL, no writes. Running it against a
// production URL is safe.

export interface MigrateCheckOptions {
  targetUrl?: string;
}

interface CheckResult {
  level: "ok" | "warn" | "error";
  message: string;
}

/**
 * Static catalog of dialect-sensitive idioms used in our SQLite schema.
 * Updated when schema.ts grows new constructs that need PG attention. The
 * "PG mapping" column is what the schema port (P1) needs to do for each.
 */
const KNOWN_DIALECT_DIFFERENCES: { area: string; sqlite: string; pg: string; risk: "ok" | "warn" | "error" }[] = [
  { area: "PK strings", sqlite: "text(\"id\").primaryKey() with UUID values", pg: "Same — text PK works in PG", risk: "ok" },
  { area: "Timestamps", sqlite: "integer(\"created_at\") storing epoch ms", pg: "Use bigint or timestamptz; pick bigint for parity", risk: "warn" },
  { area: "JSON columns", sqlite: "text() with serialized JSON", pg: "Switch to jsonb for indexable JSON", risk: "warn" },
  { area: "Booleans", sqlite: "integer 0/1 (no real bool)", pg: "Native boolean; repository casts needed", risk: "warn" },
  { area: "ON DELETE CASCADE", sqlite: "FK with cascade — works", pg: "Same syntax — works", risk: "ok" },
  { area: "Partial unique index", sqlite: "uniqueIndex(\"unique_name_content_hash\")", pg: "Partial unique idx via WHERE — supported, syntax matches", risk: "ok" },
  { area: "WAL pragma", sqlite: "PRAGMA journal_mode=WAL", pg: "N/A — PG has WAL by default; remove pragma calls", risk: "warn" },
  { area: "Foreign keys pragma", sqlite: "PRAGMA foreign_keys=ON", pg: "N/A — PG enforces FKs by default", risk: "warn" },
  { area: "Connection pool", sqlite: "single-connection serialized", pg: "Pool required (recommend pg-pool with max ≥ 10)", risk: "warn" },
];

export async function migrateCheckAction(opts: MigrateCheckOptions): Promise<void> {
  const config = getConfig();
  const sourceUrl = config.database.path;
  const targetUrl = opts.targetUrl ?? process.env.DATABASE_URL ?? sourceUrl;

  console.log();
  console.log(c.boldCyan("  Migration Compatibility Check"));
  console.log(`  ${"─".repeat(46)}`);
  console.log();

  const results: CheckResult[] = [];

  // 1. Source URL parses
  let sourceDialect: string;
  try {
    sourceDialect = parseDatabaseUrl(sourceUrl).dialect;
    results.push({ level: "ok", message: `Source URL parses (dialect=${sourceDialect})` });
  } catch (e) {
    results.push({ level: "error", message: `Source URL invalid: ${(e as Error).message}` });
    print(results);
    process.exit(1);
  }

  // 2. Target URL parses
  let targetDialect: string;
  try {
    targetDialect = parseDatabaseUrl(targetUrl).dialect;
    results.push({ level: "ok", message: `Target URL parses (dialect=${targetDialect})` });
  } catch (e) {
    results.push({ level: "error", message: `Target URL invalid: ${(e as Error).message}` });
    print(results);
    process.exit(1);
  }

  // 3. Dialect transition
  if (sourceDialect === targetDialect) {
    results.push({ level: "ok", message: `Source and target are both ${sourceDialect}; no dialect change needed` });
  } else {
    results.push({ level: "warn", message: `Dialect change: ${sourceDialect} → ${targetDialect}` });
  }

  // 4. Postgres support gate (P1 still pending)
  if (targetDialect === "postgres") {
    results.push({
      level: "error",
      message: "Postgres schema port is not yet shipped (tracked as P1 — see review §3.1.1). " +
        "The connection factory will throw at runtime if DATABASE_URL=postgres://… is used. " +
        "Use this check to plan; do NOT switch DATABASE_URL yet.",
    });
  }

  print(results);

  // 5. Known dialect differences table — informational, always shown.
  console.log();
  console.log(c.boldCyan("  Schema idioms requiring attention during PG port"));
  console.log(`  ${"─".repeat(46)}`);
  for (const diff of KNOWN_DIALECT_DIFFERENCES) {
    const tag = diff.risk === "ok" ? c.dim("[ok]  ") : c.dim("[warn]");
    console.log(`  ${tag} ${diff.area.padEnd(22)} ${c.dim("→")} ${diff.pg}`);
  }
  console.log();

  const hasError = results.some(r => r.level === "error");
  if (hasError) process.exit(1);
}

function print(results: CheckResult[]): void {
  for (const r of results) {
    const icon = r.level === "ok" ? c.dim("✓") : r.level === "warn" ? c.dim("!") : c.dim("✗");
    console.log(`  ${icon} ${r.message}`);
  }
}
