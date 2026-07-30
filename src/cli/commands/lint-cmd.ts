import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSkillMeta, CURRENT_MANIFEST_SCHEMA } from "../../utils/manifest.js";
import { scanForInjection, isTextFile } from "../../utils/security.js";
import { classifyManifestSchema } from "../../import/validator.js";
import { c, ok } from "../ui.js";

interface LintIssue {
  level: "error" | "warning" | "info";
  message: string;
  line?: number;
}

export async function lintAction(path: string): Promise<void> {
  const issues: LintIssue[] = [];
  const checks: string[] = [];

  // Check 1: SKILL.md exists
  const skillMdPath = join(path, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    issues.push({ level: "error", message: "SKILL.md not found" });
    printResults(issues);
    process.exit(1);
  }
  const skillContent = readFileSync(skillMdPath, "utf-8");
  const stats = statSync(skillMdPath);
  checks.push(`SKILL.md  ${stats.size < 1024 ? stats.size + " B" : (stats.size / 1024).toFixed(1) + " KB"}`);

  // Check 2: Parse frontmatter
  let meta;
  try {
    meta = parseSkillMeta(path);
    checks.push("Frontmatter valid");
  } catch (error) {
    issues.push({ level: "error", message: `Frontmatter parse error: ${(error as Error).message}` });
    printResults(issues);
    process.exit(1);
  }

  // Check 3: Name field
  if (!meta.name) {
    issues.push({ level: "error", message: "name is required in frontmatter" });
  } else {
    checks.push(`name  "${meta.name}"`);
  }

  // Check 4: Name length
  if (meta.name && meta.name.length > 100) {
    issues.push({ level: "error", message: `name too long (${meta.name.length} > 100 characters)` });
  }

  // P1-21 — Check: manifest_schema contract
  const schemaCheck = classifyManifestSchema(meta.manifestSchema);
  if (schemaCheck.status === "missing") {
    issues.push({
      level: "warning",
      message: `manifest_schema field is missing — run \`skill-mcp manifest:migrate\` to add \`manifest_schema: "${CURRENT_MANIFEST_SCHEMA}"\``,
    });
  } else if (schemaCheck.status === "ok") {
    checks.push(`manifest_schema  "${schemaCheck.resolved}"`);
  } else {
    issues.push({ level: "error", message: schemaCheck.reason });
  }

  // P1-11 — Check: retrieval signals
  const hasTriggers = Array.isArray(meta.triggers) && meta.triggers.length > 0;
  const hasWhenToUse = typeof meta.whenToUse === "string" && meta.whenToUse.trim().length > 0;
  const hasEmbeddingText = typeof meta.embeddingText === "string" && meta.embeddingText.trim().length > 0;
  if (!hasTriggers && !hasWhenToUse && !hasEmbeddingText) {
    issues.push({
      level: "info",
      message: "no retrieval signals (triggers / when_to_use / embedding_text) — agent search quality will degrade once skill_search ships; add at least one for best results",
    });
  } else {
    const present: string[] = [];
    if (hasTriggers) present.push(`triggers (${meta.triggers!.length})`);
    if (hasWhenToUse) present.push("when_to_use");
    if (hasEmbeddingText) present.push("embedding_text");
    checks.push(`signals  ${present.join(", ")}`);
  }

  // Check 5: Version format
  if (meta.version) {
    const versionRegex = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
    if (!versionRegex.test(meta.version)) {
      issues.push({ level: "warning", message: `version "${meta.version}" does not follow semantic versioning` });
    } else {
      checks.push(`version  "${meta.version}" (valid semver)`);
    }
  }

  // Check 6: Prompt injection scan
  const scanResult = scanForInjection(skillContent);
  if (!scanResult.safe) {
    for (const issue of scanResult.issues) {
      const lineMatch = issue.match(/Line (\d+):/);
      const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : undefined;
      issues.push({ level: "warning", message: issue, line: lineNum });
    }
  } else {
    checks.push("No suspicious patterns");
  }

  // Check 7: Referenced files exist
  if (meta.files && meta.files.length > 0) {
    let allExist = true;
    for (const filePath of meta.files) {
      if (!existsSync(join(path, filePath))) {
        issues.push({ level: "error", message: `Referenced file not found: ${filePath}` });
        allExist = false;
      }
    }
    if (allExist) checks.push(`All ${meta.files.length} referenced files exist`);
  }

  // Check 8: No path traversal
  if (meta.files) {
    for (const filePath of meta.files) {
      if (filePath.includes("..") || filePath.includes("~") || filePath.startsWith("/")) {
        issues.push({ level: "error", message: `Unsafe file path: ${filePath}` });
      }
    }
  }
  checks.push("No path traversal patterns");

  // Check 9: All files are text
  if (meta.files) {
    const nonTextFiles = meta.files.filter(f => !isTextFile(f));
    for (const file of nonTextFiles) {
      issues.push({ level: "warning", message: `Binary file detected: ${file}` });
    }
  }

  printResults(issues);

  if (issues.some(i => i.level === "error")) {
    process.exit(1);
  }
}

function printResults(issues: LintIssue[]): void {
  const errors = issues.filter(i => i.level === "error");
  const warnings = issues.filter(i => i.level === "warning");
  const infos = issues.filter(i => i.level === "info");

  if (issues.length === 0) {
    ok("All checks passed");
    return;
  }

  console.log();
  const sections: string[] = [];

  for (const issue of infos) {
    const loc = issue.line ? `  ${c.dim(`line ${issue.line}`)}` : "";
    sections.push(`  ${c.dim("ℹ")}  ${issue.message}${loc}`);
  }

  for (const issue of warnings) {
    const loc = issue.line ? `  ${c.dim(`line ${issue.line}`)}` : "";
    sections.push(`  ${c.yellow("⚠")}  ${issue.message}${loc}`);
  }

  for (const issue of errors) {
    const loc = issue.line ? `  ${c.dim(`line ${issue.line}`)}` : "";
    sections.push(`  ${c.red("✗")}  ${issue.message}${loc}`);
  }

  console.log(sections.join("\n"));

  const hasErrors = errors.length > 0;
  const icon = hasErrors ? c.boldRed("✗") : c.boldGreen("✓");
  const label = hasErrors ? c.boldRed("FAIL") : c.boldGreen("PASS");
  const counts = `${c.dim(`${infos.length} info`)}  ${c.dim(`${warnings.length} warn`)}  ${c.dim(`${errors.length} error`)}`;
  console.log(`\n  ${icon}  ${label}  ${counts}\n`);
}
