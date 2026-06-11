import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSkillMeta, CURRENT_MANIFEST_SCHEMA } from "../../utils/manifest.js";
import { scanForInjection, isTextFile } from "../../utils/security.js";
import { classifyManifestSchema } from "../../import/validator.js";

interface LintIssue {
  level: "error" | "warning" | "info";
  message: string;
  line?: number;
}

export async function lintAction(path: string): Promise<void> {
  const issues: LintIssue[] = [];

  console.log(`\nLinting skill package: ${path}\n`);

  // Check 1: SKILL.md exists
  const skillMdPath = join(path, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    issues.push({ level: "error", message: "SKILL.md not found" });
    printResults(issues);
    process.exit(1);
  }
  console.log("✓ SKILL.md exists");

  const skillContent = readFileSync(skillMdPath, "utf-8");
  const stats = statSync(skillMdPath);
  console.log(`  (${(stats.size / 1024).toFixed(1)} KB)`);

  // Check 2: Parse frontmatter
  let meta;
  try {
    meta = parseSkillMeta(path);
    console.log(`✓ Frontmatter is valid`);
  } catch (error) {
    issues.push({ level: "error", message: `Frontmatter parse error: ${(error as Error).message}` });
    printResults(issues);
    process.exit(1);
  }

  // Check 3: Name field
  if (!meta.name) {
    issues.push({ level: "error", message: "name is required in frontmatter" });
  } else {
    console.log(`✓ name: "${meta.name}"`);
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
    console.log(`✓ manifest_schema: "${schemaCheck.resolved}"`);
  } else {
    issues.push({ level: "error", message: schemaCheck.reason });
  }

  // P1-11 — Check: retrieval signals (triggers / when_to_use / embedding_text).
  // These are optional but strongly recommended for `skill_search` ranking
  // quality. Missing all three → info nudge; partial coverage → silent.
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
    console.log(`✓ retrieval signals: ${present.join(", ")}`);
  }

  // P1-12 stage 1 — Check: eval_cases. Optional but strongly recommended so
  // version transitions (stage 3) have something to regress. Missing → info
  // nudge; present → summary line with case count. Stage-1 importer caps
  // already rejected malformed shapes by this point.
  const hasEvalCases = Array.isArray(meta.evalCases) && meta.evalCases.length > 0;
  if (!hasEvalCases) {
    issues.push({
      level: "info",
      message: "no eval_cases declared — version-bump regression (P1-12 stage 3) will skip this skill; add at least one case so future upgrades can be auto-verified",
    });
  } else {
    console.log(`✓ eval_cases: ${meta.evalCases!.length} case(s)`);
  }

  // Check 5: Version format (if present)
  if (meta.version) {
    const versionRegex = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
    if (!versionRegex.test(meta.version)) {
      issues.push({ level: "warning", message: `version "${meta.version}" does not follow semantic versioning` });
    } else {
      console.log(`✓ version: "${meta.version}" (valid semver)`);
    }
  }

  // Check 6: Prompt injection scan
  const scanResult = scanForInjection(skillContent);
  if (!scanResult.safe) {
    for (const issue of scanResult.issues) {
      // Try to find line number
      const lineMatch = issue.match(/Line (\d+):/);
      const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : undefined;
      issues.push({
        level: "warning",
        message: issue,
        line: lineNum,
      });
    }
  } else {
    console.log("✓ No suspicious patterns detected");
  }

  // Check 7: Referenced files exist
  if (meta.files && meta.files.length > 0) {
    let allExist = true;
    for (const filePath of meta.files) {
      const fullPath = join(path, filePath);
      if (!existsSync(fullPath)) {
        issues.push({ level: "error", message: `Referenced file not found: ${filePath}` });
        allExist = false;
      }
    }
    if (allExist) {
      console.log(`✓ All ${meta.files.length} referenced files exist`);
    }
  }

  // Check 8: No path traversal
  if (meta.files) {
    for (const filePath of meta.files) {
      if (filePath.includes("..") || filePath.includes("~") || filePath.startsWith("/")) {
        issues.push({ level: "error", message: `Unsafe file path: ${filePath}` });
      }
    }
  }
  console.log("✓ No path traversal patterns found");

  // Check 9: All files are text (warning only)
  if (meta.files) {
    const nonTextFiles = meta.files.filter(f => !isTextFile(f));
    if (nonTextFiles.length > 0) {
      for (const file of nonTextFiles) {
        issues.push({ level: "warning", message: `Binary file detected: ${file}` });
      }
    }
  }

  printResults(issues);

  if (issues.some(i => i.level === "error")) {
    process.exit(1);
  }
}

function printResults(issues: LintIssue[]): void {
  if (issues.length === 0) {
    console.log("\n✨ No issues found — PASS\n");
    return;
  }

  console.log("\n" + "=".repeat(80));
  const errors = issues.filter(i => i.level === "error");
  const warnings = issues.filter(i => i.level === "warning");
  const infos = issues.filter(i => i.level === "info");

  if (infos.length > 0) {
    console.log("\nInfo:");
    for (const issue of infos) {
      const loc = issue.line ? ` (line ${issue.line})` : "";
      console.log(`  ℹ ${issue.message}${loc}`);
    }
  }

  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const issue of warnings) {
      const loc = issue.line ? ` (line ${issue.line})` : "";
      console.log(`  ⚠ ${issue.message}${loc}`);
    }
  }

  if (errors.length > 0) {
    console.log("\nErrors:");
    for (const issue of errors) {
      const loc = issue.line ? ` (line ${issue.line})` : "";
      console.log(`  ✗ ${issue.message}${loc}`);
    }
  }

  console.log(`\nResult: ${infos.length} info, ${warnings.length} warning(s), ${errors.length} error(s) — ${errors.length > 0 ? "FAIL" : "PASS"}\n`);
}
