import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSkillMeta } from "../../utils/manifest.js";
import { scanForInjection, isTextFile } from "../../utils/security.js";

interface LintIssue {
  level: "error" | "warning";
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

  console.log(`\nResult: ${warnings.length} warning(s), ${errors.length} error(s) — ${errors.length > 0 ? "FAIL" : "PASS"}\n`);
}
