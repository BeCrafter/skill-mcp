import type { SkillFrontmatter } from "../types/index.js";
import { scanForInjection, type ScanResult } from "../utils/security.js";
import {
  CURRENT_MANIFEST_SCHEMA,
  MAX_SUPPORTED_MANIFEST_MAJOR,
  MANIFEST_SCHEMA_PATTERN,
} from "../utils/manifest.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** P1-21 — non-fatal warnings (deprecation hints, schema migration nudges). */
  warnings: string[];
  scanResult?: ScanResult;
  /** P1-21 — resolved schema version after coercion (always set, even when missing). */
  resolvedSchema: string;
}

/**
 * P1-21 — classify a manifest_schema value against the server's supported
 * range. See §14.5 of the commercialization review for the contract. The
 * caller decides whether to log + coerce (legacy) or hard-fail (future major).
 */
export type SchemaCheck =
  | { status: "missing"; resolved: string }
  | { status: "ok"; resolved: string }
  | { status: "invalid"; reason: string }
  | { status: "unsupported-major"; reason: string };

export function classifyManifestSchema(raw: string | undefined): SchemaCheck {
  if (raw === undefined || raw === null || raw === "") {
    return { status: "missing", resolved: CURRENT_MANIFEST_SCHEMA };
  }
  if (typeof raw !== "string" || !MANIFEST_SCHEMA_PATTERN.test(raw)) {
    return {
      status: "invalid",
      reason: `manifest_schema "${String(raw)}" is not a valid "<major>.<minor>" version`,
    };
  }
  const [majorStr] = raw.split(".");
  const major = parseInt(majorStr, 10);
  if (Number.isNaN(major)) {
    return { status: "invalid", reason: `manifest_schema "${raw}" has a non-numeric major` };
  }
  if (major === 0) {
    // Treat 0.x as legacy — coerce upward but record the migration nudge so
    // operators see deprecation warnings during import.
    return { status: "missing", resolved: CURRENT_MANIFEST_SCHEMA };
  }
  if (major > MAX_SUPPORTED_MANIFEST_MAJOR) {
    return {
      status: "unsupported-major",
      reason: `manifest_schema "${raw}" requires server major >= ${major}, but this server only supports up to ${MAX_SUPPORTED_MANIFEST_MAJOR}.x — please upgrade Skill-MCP`,
    };
  }
  return { status: "ok", resolved: raw };
}

export function validateSkillPackage(
  meta: SkillFrontmatter,
  entryContent: string | null,
  enableInjectionScan: boolean = true,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!meta.name || typeof meta.name !== "string") {
    errors.push("name is required in SKILL.md frontmatter and must be a string");
  }

  if (meta.name && meta.name.length > 100) {
    errors.push("name must be 100 characters or less");
  }

  if (!entryContent) {
    errors.push("Entry file (SKILL.md) is missing or empty");
  }

  // P1-21 — manifest_schema contract (§14.5). Missing/legacy = warning;
  // unsupported future major = hard error so operators upgrade rather than
  // silently importing broken data.
  const schemaCheck = classifyManifestSchema(meta.manifestSchema);
  let resolvedSchema = CURRENT_MANIFEST_SCHEMA;
  if (schemaCheck.status === "missing") {
    warnings.push(
      `manifest_schema field is missing or legacy — coercing to "${CURRENT_MANIFEST_SCHEMA}". Run \`skill-mcp manifest:migrate\` to add it explicitly. This implicit coercion will be removed in a future major version.`,
    );
    resolvedSchema = schemaCheck.resolved;
  } else if (schemaCheck.status === "ok") {
    resolvedSchema = schemaCheck.resolved;
  } else {
    errors.push(schemaCheck.reason);
  }

  let scanResult: ScanResult | undefined;
  if (enableInjectionScan && entryContent) {
    scanResult = scanForInjection(entryContent);
    if (!scanResult.safe) {
      errors.push(`Security: ${scanResult.issues.join("; ")}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings, scanResult, resolvedSchema };
}
