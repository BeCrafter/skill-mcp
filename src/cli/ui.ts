import { styleText } from "node:util";

const isColorEnabled = () => process.stdout.isTTY && process.env.NO_COLOR === undefined;

function s(fmt: Parameters<typeof styleText>[0], text: string): string {
  return isColorEnabled() ? styleText(fmt, text, { validateStream: false }) : text;
}

// ── Colors ──────────────────────────────────────────────────────────

export const c = {
  bold:       (t: string) => s("bold", t),
  dim:        (t: string) => s("dim", t),
  italic:     (t: string) => s("italic", t),
  underline:  (t: string) => s("underline", t),
  strikethrough: (t: string) => s("strikethrough", t),

  red:        (t: string) => s("red", t),
  green:      (t: string) => s("green", t),
  yellow:     (t: string) => s("yellow", t),
  blue:       (t: string) => s("blue", t),
  magenta:    (t: string) => s("magenta", t),
  cyan:       (t: string) => s("cyan", t),
  white:      (t: string) => s("white", t),
  gray:       (t: string) => s("dim", t),

  bgRed:      (t: string) => s("bgRed", t),
  bgGreen:    (t: string) => s("bgGreen", t),
  bgYellow:   (t: string) => s("bgYellow", t),
  bgBlue:     (t: string) => s("bgBlue", t),
  bgMagenta:  (t: string) => s("bgMagenta", t),
  bgCyan:     (t: string) => s("bgCyan", t),
  bgWhite:    (t: string) => s("bgWhite", t),

  boldRed:    (t: string) => s(["bold", "red"], t),
  boldGreen:  (t: string) => s(["bold", "green"], t),
  boldYellow: (t: string) => s(["bold", "yellow"], t),
  boldBlue:   (t: string) => s(["bold", "blue"], t),
  boldMagenta:(t: string) => s(["bold", "magenta"], t),
  boldCyan:   (t: string) => s(["bold", "cyan"], t),
  boldWhite:  (t: string) => s(["bold", "white"], t),

  dimRed:     (t: string) => s(["dim", "red"], t),
  dimGreen:   (t: string) => s(["dim", "green"], t),
  dimYellow:  (t: string) => s(["dim", "yellow"], t),
  dimBlue:    (t: string) => s(["dim", "blue"], t),
  dimMagenta: (t: string) => s(["dim", "magenta"], t),
  dimCyan:    (t: string) => s(["dim", "cyan"], t),
};

// ── ANSI helpers ────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- ANSI escape sequence pattern is intentional
const ANSI_RE = /\x1B\[[0-9;]*m/g;

/** Strip ANSI escape sequences and return visible character count. */
function lineWidth(str: string): number {
  return str.replace(ANSI_RE, "").length;
}

/** Max width among multiple lines. */
export function maxLineWidth(...lines: string[]): number {
  return Math.max(0, ...lines.map(lineWidth));
}

// ── Banner ─────────────────────────────────────────────────────────

/**
 * CLI startup banner.
 *
 *   skill-mcp  v0.1.1-beta.0                        (no description)
 *   skill-mcp  v0.1.1-beta.0                        (with description)
 *   Cloud Skill File System & MCP Gateway
 */
export function banner(name: string, version: string, description?: string): string {
  const lines = [`  ${c.boldCyan(name)}  ${c.dim(version)}`];
  if (description) lines.push(`  ${c.dim(description)}`);
  return lines.join("\n");
}

// ── Section header ──────────────────────────────────────────────────

/**
 * Minimal section header — bold title with subtle line.
 * Line width defaults to terminal columns (capped at 72).
 * Pass explicit width to match content below.
 *
 *   Skills  3
 *   ──────────────────────────────────────────────
 */
export function section(title: string, count?: number, width?: number): string {
  const label = count !== undefined ? `${title}  ${c.dim(String(count))}` : title;
  const w = width ?? Math.min(process.stdout.columns ?? 72, 72);
  return `\n  ${c.bold(label)}\n  ${c.dim("─".repeat(w))}`;
}

/**
 * Calculate the width needed for a set of kv lines.
 * Use with section() to match the content width.
 */
export function kvWidth(keyWidth = 12, ...values: string[]): number {
  const maxVal = values.reduce((max, v) => Math.max(max, lineWidth(v)), 0);
  return 4 + keyWidth + 2 + maxVal;
}

// ── Key-value pairs ─────────────────────────────────────────────────

/**
 * Two-column key-value display. Key is dimmed, value is normal.
 *
 *     mode       local
 *     port       3001
 */
export function kv(key: string, value: string, keyWidth = 12): string {
  return `    ${c.dim(key.padEnd(keyWidth))}  ${value}`;
}

// ── Table ───────────────────────────────────────────────────────────

interface Column {
  key: string;
  header: string;
  width: number;
  align?: "left" | "right";
  format?: (value: unknown) => string;
}

export function table(rows: Array<Record<string, unknown>>, columns: Column[]): string {
  if (rows.length === 0) return "";

  // Auto-compute column widths from actual content
  const computedColumns = columns.map(col => {
    let maxWidth = col.header.length;
    for (const row of rows) {
      const raw = row[col.key] ?? "";
      const text = col.format ? col.format(raw) : String(raw);
      const visibleLen = lineWidth(text);
      if (visibleLen > maxWidth) maxWidth = visibleLen;
    }
    return { ...col, width: Math.max(col.width, maxWidth) };
  });

  // Header
  const headerLine = computedColumns.map(col => c.dim(col.header.padEnd(col.width))).join("  ");

  const lines: string[] = [
    `    ${headerLine}`,
  ];

  // Rows
  for (const row of rows) {
    const cells = computedColumns.map(col => {
      const raw = row[col.key] ?? "";
      const rawText = String(raw);
      if (col.format) {
        // Pad raw text first, then apply format (e.g. color) so ANSI codes
        // don't interfere with padEnd's character count.
        const padded = col.align === "right"
          ? rawText.padStart(col.width)
          : rawText.padEnd(col.width);
        return col.format(padded);
      }
      return col.align === "right" ? rawText.padStart(col.width) : rawText.padEnd(col.width);
    });
    lines.push(`    ${cells.join("  ")}`);
  }

  return lines.join("\n");
}

// ── Status badges ───────────────────────────────────────────────────

/**
 * Status badge with colored indicator.
 *
 *   ● published    (green)
 *   ○ draft        (yellow)
 *   ◌ archived     (dim)
 */
export function badge(status: string): string {
  switch (status) {
    case "published": return `${c.green("●")}  published`;
    case "draft":     return `${c.yellow("○")}  draft`;
    case "archived":  return `${c.dim("◌")}  archived`;
    default:          return `${c.dim("○")}  ${status}`;
  }
}

// ── Result output ───────────────────────────────────────────────────

/**
 * Success result — primary message + optional detail lines.
 *
 *   ✓  Created  my-skill  v1.2.0
 *      id         abc123
 *      slug       my-skill
 */
export function ok(msg: string, details?: Array<{ key: string; value: string }>): void {
  const lines = [`\n  ${c.boldGreen("✓")}  ${msg}`];
  if (details) {
    for (const d of details) lines.push(kv(d.key, d.value));
  }
  lines.push("");
  console.log(lines.join("\n"));
}

/**
 * Failure result — error message + optional hint.
 *
 *   ✗  Skill not found: my-skill
 *      → Use `skill-mcp list` to see available skills
 */
export function fail(msg: string, hintMsg?: string): void {
  if (hintMsg) {
    console.error(`\n  ${c.boldRed("✗")}  ${msg}\n  ${c.dim("→ " + hintMsg)}\n`);
  } else {
    console.error(`\n  ${c.boldRed("✗")}  ${msg}\n`);
  }
}

/**
 * Warning — inline yellow indicator.
 *
 *   ⚡  No skills found.
 */
export function warn(msg: string): void {
  console.log(`  ${c.yellow("⚡")}  ${msg}`);
}

/**
 * Hint — dimmed suggestion line, used after fail() or standalone.
 *
 *   → Use `skill-mcp list` to see available skills
 */
export function hint(msg: string): void {
  console.log(`  ${c.dim("→ " + msg)}`);
}

// ── Utilities ───────────────────────────────────────────────────────

export function truncate(text: string, max = 70): string {
  const clean = text.replace(/^["'\s]+|["'\s]+$/g, "");
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

export function fmtDate(ts: number | null | undefined): string {
  if (ts == null) return "-";
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

export function sep(width = 52): string {
  return c.dim("─".repeat(width));
}

export function detail(key: string, value: string, keyWidth = 10): string {
  return `     ${c.dim(key.padEnd(keyWidth))}  ${value}`;
}

export function list(items: string[]): string {
  return items.map((item) => `     ${c.dim("•")}  ${item}`).join("\n");
}

export function infoBox(title: string, items: Array<{ key: string; value: string }>): void {
  const keyWidth = Math.max(...items.map(i => i.key.length), 0);
  console.error(`  ${c.cyan("ℹ")}  ${c.bold(title)}`);
  items.forEach(item => {
    console.error(`     ${c.dim(item.key.padEnd(keyWidth))}  ${item.value}`);
  });
}
