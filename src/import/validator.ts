import type { SkillManifest } from "../types/index.js";
import { scanForInjection, type ScanResult } from "../utils/security.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  scanResult?: ScanResult;
}

export function validateSkillPackage(
  manifest: SkillManifest,
  entryContent: string | null,
  enableInjectionScan: boolean = true,
): ValidationResult {
  const errors: string[] = [];

  // Validate manifest
  if (!manifest.name || typeof manifest.name !== "string") {
    errors.push("manifest.name is required and must be a string");
  }

  if (manifest.name && manifest.name.length > 100) {
    errors.push("manifest.name must be 100 characters or less");
  }

  // Validate entry file
  if (!entryContent) {
    errors.push("Entry file (SKILL.md) is missing or empty");
  }

  // Security scan
  let scanResult: ScanResult | undefined;
  if (enableInjectionScan && entryContent) {
    scanResult = scanForInjection(entryContent);
    if (!scanResult.safe) {
      errors.push(`Security: ${scanResult.issues.join("; ")}`);
    }
  }

  return { valid: errors.length === 0, errors, scanResult };
}
