import { getConfig } from "../../config/index.js";
import { parseDatabaseUrl } from "../../db/dialect.js";
import { c, table, section } from "../ui.js";

export interface MigrateCheckOptions {
  targetUrl?: string;
}

interface CheckResult {
  level: "ok" | "warn" | "error";
  message: string;
}

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

  console.log(section("migration check"));
  console.log();

  const results: CheckResult[] = [];

  let sourceDialect: string;
  try {
    sourceDialect = parseDatabaseUrl(sourceUrl).dialect;
    results.push({ level: "ok", message: `Source URL parses as ${sourceDialect}` });
  } catch (e) {
    results.push({ level: "error", message: `Cannot parse source URL: ${(e as Error).message}` });
    sourceDialect = "unknown";
  }

  let targetDialect: string;
  try {
    targetDialect = parseDatabaseUrl(targetUrl).dialect;
    results.push({ level: "ok", message: `Target URL parses as ${targetDialect}` });
  } catch (e) {
    results.push({ level: "error", message: `Cannot parse target URL: ${(e as Error).message}` });
    targetDialect = "unknown";
  }

  if (sourceDialect === targetDialect) {
    results.push({ level: "ok", message: `Source and target are both ${sourceDialect}; no dialect change needed` });
  } else {
    results.push({ level: "warn", message: `Dialect change: ${sourceDialect} → ${targetDialect}` });
  }

  if (targetDialect === "postgres") {
    results.push({ level: "warn", message: "PostgreSQL support is not yet production-ready (P1 roadmap)" });
  }

  printResults(results);

  // Known dialect differences table
  console.log(section("schema idiom mapping", undefined, 28));
  console.log();
  for (const d of KNOWN_DIALECT_DIFFERENCES) {
    const icon = d.risk === "ok" ? c.dim("○") : d.risk === "warn" ? c.boldYellow("●") : c.boldRed("●");
    console.log(`    ${c.dim(d.area.padEnd(20))}  ${icon}`);
  }
  console.log();

  const hasError = results.some(r => r.level === "error");
  if (hasError) process.exit(1);
}

function printResults(results: CheckResult[]): void {
  const rows = results.map(r => ({
    status: r.level === "ok" ? c.dim("○") : r.level === "warn" ? c.boldYellow("●") : c.boldRed("●"),
    message: r.message,
  }));

  console.log(table(rows, [
    { key: "status", header: "", width: 2 },
    { key: "message", header: "CHECK", width: 60 },
  ]));
  console.log();
}
