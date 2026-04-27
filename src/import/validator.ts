import type { SkillFrontmatter } from "../types/index.js";
import { scanForInjection, type ScanResult } from "../utils/security.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  scanResult?: ScanResult;
}

export function validateSkillPackage(
  meta: SkillFrontmatter,
  entryContent: string | null,
  enableInjectionScan: boolean = true,
): ValidationResult {
  const errors: string[] = [];

  if (!meta.name || typeof meta.name !== "string") {
    errors.push("name is required in SKILL.md frontmatter and must be a string");
  }

  if (meta.name && meta.name.length > 100) {
    errors.push("name must be 100 characters or less");
  }

  if (!entryContent) {
    errors.push("Entry file (SKILL.md) is missing or empty");
  }

  let scanResult: ScanResult | undefined;
  if (enableInjectionScan && entryContent) {
    scanResult = scanForInjection(entryContent);
    if (!scanResult.safe) {
      errors.push(`Security: ${scanResult.issues.join("; ")}`);
    }
  }

  return { valid: errors.length === 0, errors, scanResult };
}
