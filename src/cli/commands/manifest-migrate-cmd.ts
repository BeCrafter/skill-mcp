/**
 * P1-21 — `skill-mcp manifest:migrate <dir>` (review doc §14.5.4).
 *
 * Scans a directory tree for skill packages (any folder with a `SKILL.md`),
 * detects packages that lack a `manifest_schema` field, and either prints a
 * dry-run diff (default) or rewrites the YAML frontmatter to inject
 * `manifest_schema: "<CURRENT_MANIFEST_SCHEMA>"`.
 *
 * Modes:
 * - default       — dry-run: print summary and unified diff per package
 * - --apply       — rewrite SKILL.md in place
 * - --patch       — emit a single unified diff to stdout (suitable for
 *                   `git apply` / code review). Implies dry-run.
 *
 * Design notes:
 * - The injection is intentionally line-oriented (insert a single line into
 *   the existing frontmatter block) rather than a YAML re-serialise. A
 *   full YAML round-trip would normalise quoting / key ordering / comments
 *   and produce noisy diffs that scare reviewers off thousand-skill repos.
 * - We refuse to rewrite a file whose frontmatter we cannot parse; the
 *   migration is opt-in additive only.
 * - We never follow symlinks (matches T-601 import-side discipline).
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { CURRENT_MANIFEST_SCHEMA } from "../../utils/manifest.js";
import { classifyManifestSchema } from "../../import/validator.js";
import { extractFrontmatter } from "../../utils/manifest.js";
import { c } from "../ui.js";

export interface ManifestMigrateOptions {
  apply?: boolean;
  patch?: boolean;
}

interface PackageScan {
  /** Absolute path to SKILL.md */
  filePath: string;
  /** Relative path printed for human-friendly output */
  relPath: string;
  status: "ok" | "missing" | "invalid" | "unsupported-major" | "unparseable";
  reason?: string;
  /** Computed file content after migration (only set when status=missing) */
  newContent?: string;
  /** Original file content */
  originalContent?: string;
}

const MAX_WALK_DEPTH = 16;

/** Walk a tree collecting every directory that contains a `SKILL.md`. */
function findSkillPackages(root: string): string[] {
  const found: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some(e => e.isFile() && e.name === "SKILL.md")) {
      found.push(dir);
    }

    for (const e of entries) {
      if ([".git", "node_modules", ".versions", "__staging__"].includes(e.name)) continue;
      const full = join(dir, e.name);
      let lst;
      try {
        lst = lstatSync(full);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) continue;
      if (lst.isDirectory()) walk(full, depth + 1);
    }
  }

  walk(root, 0);
  return found;
}

/**
 * Inject `manifest_schema: "1.0"` into the YAML frontmatter of a SKILL.md
 * body. Returns null if no frontmatter block exists or if a `manifest_schema`
 * key is already present. The insertion is placed immediately after the
 * leading `---` so it's the first key — easy to spot in diffs.
 */
export function injectManifestSchema(content: string, schema = CURRENT_MANIFEST_SCHEMA): string | null {
  // Match the leading frontmatter delimiter and capture the trailing newline
  // style so we preserve CRLF/LF.
  const match = content.match(/^---(\r?\n)([\s\S]*?\r?\n)---(\r?\n?)/);
  if (!match) return null;
  const [, newline, fmBody, closingNewline] = match;
  // Already present? bail. Comments / nested blocks aren't expected in our
  // frontmatter, so a simple line-prefix scan is sufficient.
  if (/^\s*manifest_schema\s*:/m.test(fmBody)) return null;
  const insertion = `manifest_schema: "${schema}"${newline}`;
  const rest = content.slice(match[0].length);
  return `---${newline}${insertion}${fmBody}---${closingNewline}${rest}`;
}

function unifiedDiff(relPath: string, before: string, after: string): string {
  // Minimal hand-rolled unified diff. The migration only adds a single line,
  // so we can synthesise the @@ hunk by spotting the first differing line.
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let firstDiff = 0;
  while (
    firstDiff < beforeLines.length &&
    firstDiff < afterLines.length &&
    beforeLines[firstDiff] === afterLines[firstDiff]
  ) {
    firstDiff++;
  }
  const ctxStart = Math.max(0, firstDiff - 2);
  const lines: string[] = [];
  lines.push(`--- a/${relPath}`);
  lines.push(`+++ b/${relPath}`);
  // Pre-context
  for (let i = ctxStart; i < firstDiff; i++) {
    lines.push(` ${beforeLines[i]}`);
  }
  // The added line(s) — for our additive migration there's exactly one
  lines.push(`+${afterLines[firstDiff]}`);
  // Trailing context
  const tailEnd = Math.min(afterLines.length, firstDiff + 3);
  for (let i = firstDiff + 1; i < tailEnd; i++) {
    lines.push(` ${afterLines[i]}`);
  }
  // Hunk header
  const beforeCount = firstDiff - ctxStart + (tailEnd - firstDiff - 1);
  const afterCount = firstDiff - ctxStart + (tailEnd - firstDiff);
  const header = `@@ -${ctxStart + 1},${beforeCount} +${ctxStart + 1},${afterCount} @@`;
  lines.splice(2, 0, header);
  return lines.join("\n") + "\n";
}

export function scanPackages(rootDir: string): PackageScan[] {
  const skillDirs = findSkillPackages(rootDir);
  const results: PackageScan[] = [];
  for (const dir of skillDirs) {
    const filePath = join(dir, "SKILL.md");
    const relPath = relative(rootDir, filePath) || filePath;
    let originalContent: string;
    try {
      originalContent = readFileSync(filePath, "utf-8");
    } catch (err) {
      results.push({
        filePath, relPath,
        status: "unparseable",
        reason: `read error: ${(err as Error).message}`,
      });
      continue;
    }
    const { frontmatter } = extractFrontmatter(originalContent);
    if (Object.keys(frontmatter).length === 0) {
      results.push({
        filePath, relPath, originalContent,
        status: "unparseable",
        reason: "no YAML frontmatter detected",
      });
      continue;
    }
    const schemaRaw = (frontmatter["manifest_schema"] as string | undefined);
    const check = classifyManifestSchema(schemaRaw);
    if (check.status === "ok") {
      results.push({ filePath, relPath, originalContent, status: "ok" });
    } else if (check.status === "unsupported-major") {
      results.push({
        filePath, relPath, originalContent,
        status: "unsupported-major",
        reason: check.reason,
      });
    } else if (check.status === "invalid") {
      results.push({
        filePath, relPath, originalContent,
        status: "invalid",
        reason: check.reason,
      });
    } else {
      // missing → compute migration target
      const newContent = injectManifestSchema(originalContent);
      if (newContent === null) {
        results.push({
          filePath, relPath, originalContent,
          status: "unparseable",
          reason: "frontmatter delimiter not in expected shape",
        });
      } else {
        results.push({
          filePath, relPath,
          status: "missing",
          originalContent, newContent,
        });
      }
    }
  }
  return results;
}

export async function manifestMigrateAction(dir: string, opts: ManifestMigrateOptions): Promise<void> {
  const root = dir;
  if (!existsSync(root)) {
    console.error(c.red(`Directory not found: ${root}`));
    process.exit(1);
  }
  if (!statSync(root).isDirectory()) {
    console.error(c.red(`Not a directory: ${root}`));
    process.exit(1);
  }

  const scans = scanPackages(root);
  const missing = scans.filter(s => s.status === "missing");
  const ok = scans.filter(s => s.status === "ok");
  const errors = scans.filter(s => s.status === "invalid" || s.status === "unsupported-major" || s.status === "unparseable");

  if (opts.patch) {
    // Patch mode: emit unified diff only, suitable for `git apply`
    if (missing.length === 0) {
      console.error(c.dim("# no packages need migration"));
      return;
    }
    for (const m of missing) {
      process.stdout.write(unifiedDiff(m.relPath, m.originalContent!, m.newContent!));
    }
    return;
  }

  console.log(`\nScanning: ${root}`);
  console.log(`Found ${scans.length} skill package(s)\n`);

  if (ok.length > 0) {
    console.log(c.green(`✓ ${ok.length} package(s) already on schema "${CURRENT_MANIFEST_SCHEMA}"`));
  }
  if (errors.length > 0) {
    console.log(c.red(`✗ ${errors.length} package(s) have schema errors:`));
    for (const e of errors) {
      console.log(`  - ${e.relPath}: ${e.reason}`);
    }
  }
  if (missing.length === 0) {
    if (errors.length > 0) {
      process.exit(1);
    }
    console.log(c.green("\n✨ All packages already declare manifest_schema — nothing to do.\n"));
    return;
  }

  console.log(c.yellow(`\n${missing.length} package(s) missing manifest_schema:`));
  for (const m of missing) {
    console.log(`  + ${m.relPath} → "${CURRENT_MANIFEST_SCHEMA}"`);
  }

  if (!opts.apply) {
    console.log(c.dim(`\nDry-run only. Re-run with --apply to rewrite ${missing.length} file(s),`));
    console.log(c.dim(`or with --patch to emit a unified diff to stdout (e.g. \`skill-mcp manifest:migrate ${root} --patch | git apply\`).\n`));
    if (errors.length > 0) {
      process.exit(1);
    }
    return;
  }

  // --apply: rewrite files
  let applied = 0;
  for (const m of missing) {
    try {
      writeFileSync(m.filePath, m.newContent!, "utf-8");
      applied++;
    } catch (err) {
      console.error(c.red(`Failed to write ${m.relPath}: ${(err as Error).message}`));
    }
  }
  console.log(c.green(`\n✓ Migrated ${applied}/${missing.length} package(s).\n`));
  if (errors.length > 0 || applied < missing.length) {
    process.exit(1);
  }
}
