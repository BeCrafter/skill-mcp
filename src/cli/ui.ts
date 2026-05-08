import { styleText } from "node:util";

const noColor = !process.stdout.isTTY || process.env.NO_COLOR !== undefined;

function s(fmt: Parameters<typeof styleText>[0], text: string): string {
  if (noColor || !text) return text;
  try { return styleText(fmt, text); } catch { return text; }
}

export const c = {
  bold:      (t: string) => s("bold", t),
  dim:       (t: string) => s("dim", t),
  cyan:      (t: string) => s("cyan", t),
  green:     (t: string) => s("green", t),
  yellow:    (t: string) => s("yellow", t),
  red:       (t: string) => s("red", t),
  boldCyan:  (t: string) => s(["bold", "cyan"], t),
  boldGreen: (t: string) => s(["bold", "green"], t),
  boldRed:   (t: string) => s(["bold", "red"], t),
};

export function truncate(text: string, max = 70): string {
  const clean = text.replace(/^["'\s]+|["'\s]+$/g, "");
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

export function sep(width = 52): string {
  return c.dim("─".repeat(width));
}

export function badge(status: string): string {
  if (status === "published") return c.green("● published");
  if (status === "draft")     return c.yellow("○ draft");
  return c.dim(`○ ${status}`);
}

export function kv(key: string, value: string, keyWidth = 13): string {
  return `  ${c.dim(key.padEnd(keyWidth))}  ${value}`;
}

export function ok(msg: string): void {
  console.log(`\n  ${c.boldGreen("✓")}  ${msg}\n`);
}

export function fail(msg: string): void {
  console.error(`\n  ${c.boldRed("✗")}  ${msg}\n`);
}

export function warn(msg: string): void {
  console.log(`  ${c.yellow("!")}  ${msg}`);
}

export function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

export function detail(key: string, value: string, keyWidth = 10): string {
  return `     ${c.dim(key.padEnd(keyWidth))}  ${value}`;
}

export function list(items: string[]): string {
  return items.map((item, i) => `     ${c.dim("•")}  ${item}`).join("\n");
}

export function infoBox(title: string, items: Array<{ key: string; value: string }>): void {
  const keyWidth = Math.max(...items.map(i => i.key.length), 0);
  console.error(`  ${c.cyan("ℹ")}  ${c.bold(title)}`);
  items.forEach(item => {
    console.error(`     ${c.dim(item.key.padEnd(keyWidth))}  ${item.value}`);
  });
}
