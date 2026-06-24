import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { getLogger } from "./logger.js";
import { InvalidPathError } from "./errors.js";
import type { SkillFrontmatter, SkillFileInput, SkillEvalCase } from "../types/index.js";

// T-601 — bound walk so a malicious skill package can't blow the stack via
// pathologically deep directory nesting.
const MAX_WALK_DEPTH = 16;
// T-601 — bound total file count and bytes per package. Numbers chosen to
// be generous (legitimate skills are tens of files, hundreds of KB) while
// rejecting zip-bomb-style payloads.
const MAX_FILES_PER_PACKAGE = 1000;
const MAX_BYTES_PER_PACKAGE = 50 * 1024 * 1024;

// T-705 — frontmatter field caps. Without these, a malicious skill package
// can ride MAX_BYTES_PER_PACKAGE (50 MiB) and stuff multi-megabyte strings
// into `description` / `version` / per-tag entries, which then get persisted
// to SQLite TEXT columns and re-served to every client that lists the skill.
// Caps chosen to comfortably exceed legitimate use (semver pre-release tail,
// long marketing copy) while rejecting payloads designed to balloon listing
// responses.
const MAX_NAME_LENGTH = 200;
const MAX_VERSION_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 4096;
const MAX_CATEGORY_LENGTH = 128;
const MAX_TAGS_COUNT = 64;
const MAX_TAG_LENGTH = 64;
// P1-11 — retrieval-signal caps. Mirror the description-class limits so a
// malicious package can't ride MAX_BYTES_PER_PACKAGE into multi-MB strings
// that would balloon listing responses or embedding API calls.
const MAX_TRIGGERS_COUNT = 32;
const MAX_TRIGGER_LENGTH = 128;
const MAX_WHEN_TO_USE_LENGTH = 2048;
const MAX_EMBEDDING_TEXT_LENGTH = 8192;
// P1-12 — eval-case caps. A case is structurally `name + input + 0..3 lists
// of expectations`; without caps a malicious package could ship 1000 cases
// with multi-MB inputs and balloon both validation cost and the row payload
// once stage 2 persists them. Numbers chosen to match real-world test suites
// (tens of cases per skill, prompt sized like a chat turn).
const MAX_EVAL_CASES = 32;
const MAX_EVAL_NAME_LENGTH = 128;
const MAX_EVAL_INPUT_LENGTH = 4096;
const MAX_EVAL_EXPECT_ENTRIES = 16;
const MAX_EVAL_EXPECT_LENGTH = 1024;

/**
 * P1-21 — Manifest schema version contract (review doc §14.5).
 *
 * `CURRENT_MANIFEST_SCHEMA` is the version this server emits when migrating
 * legacy packages. `MAX_SUPPORTED_MANIFEST_MAJOR` is the highest major the
 * server will accept; anything higher fails validation with "server too old,
 * please upgrade" so customers shipping v2 manifests against a v1 server get
 * a clear error instead of silent corruption.
 *
 * Evolution rules (mirror §14.2):
 * - minor (1.x → 1.y): only additive optional fields
 * - major (1.x → 2.x): semantics may change, must double-schema for one
 *   minor cycle, must ship `manifest:migrate` tooling
 */
export const CURRENT_MANIFEST_SCHEMA = "1.0";
export const MAX_SUPPORTED_MANIFEST_MAJOR = 1;
export const MANIFEST_SCHEMA_PATTERN = /^\d+\.\d+$/;

/**
 * T-601 — refuse any meta-declared path that would resolve outside the
 * skill root after normalization. Catches `..` traversal, absolute paths,
 * and Windows-style drive prefixes once `path.resolve` has its way.
 */
function safeJoin(base: string, child: string): string {
  const resolvedBase = resolve(base);
  const resolved = resolve(resolvedBase, child);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + sep)) {
    throw new InvalidPathError(child);
  }
  return resolved;
}

/**
 * P1-12 stage 1 — accept either snake_case (`expected_tools`) or camelCase
 * (`expectedTools`) in the YAML frontmatter, normalize to camelCase. Returns
 * `undefined` when the input is missing / not an array so downstream callers
 * can preserve "absent" vs "explicitly empty" distinctions.
 *
 * NOTE: this only normalizes shape — caps and uniqueness are enforced later
 * by `validateSkillMetaFields`. Keeping parse + validate separate matches the
 * pattern used for triggers/whenToUse and means malformed YAML still surfaces
 * a typed error from the validator.
 */
export function parseEvalCases(raw: unknown): SkillEvalCase[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return raw as never; // let validator reject
  return raw.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return item as never; // pass through; validator will reject
    }
    const r = item as Record<string, unknown>;
    const out: SkillEvalCase = {
      name: r["name"] as string,
      input: r["input"] as string,
    };
    const tools = r["expected_tools"] ?? r["expectedTools"];
    if (tools !== undefined) out.expectedTools = tools as string[];
    const contains = r["expected_output_contains"] ?? r["expectedOutputContains"];
    if (contains !== undefined) out.expectedOutputContains = contains as string[];
    const notContains = r["expected_output_not_contains"] ?? r["expectedOutputNotContains"];
    if (notContains !== undefined) out.expectedOutputNotContains = notContains as string[];
    return out;
  });
}

/**
 * Parse skill metadata from SKILL.md frontmatter.
 */
export function parseSkillMeta(dirPath: string): SkillFrontmatter {
  if (existsSync(join(dirPath, "manifest.json"))) {
    getLogger().warn("manifest.json is deprecated; metadata should be defined in SKILL.md frontmatter");
  }

  const skillMdPath = join(dirPath, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    throw new Error(`SKILL.md not found in ${dirPath}`);
  }

  const skillContent = readFileSync(skillMdPath, "utf-8");
  const { frontmatter } = extractFrontmatter(skillContent);

  const name = frontmatter["name"];
  if (!name || typeof name !== "string") {
    throw new Error("name is required in SKILL.md frontmatter");
  }

  return {
    name: name as string,
    version: (frontmatter["version"] as string) ?? undefined,
    description: (frontmatter["description"] as string) ?? undefined,
    entry: (frontmatter["entry"] as string) ?? "SKILL.md",
    files: frontmatter["files"] as string[] | undefined,
    tags: frontmatter["tags"] as string[] | undefined,
    category: (frontmatter["category"] as string) ?? undefined,
    manifestSchema: (frontmatter["manifest_schema"] as string) ?? undefined,
    triggers: frontmatter["triggers"] as string[] | undefined,
    whenToUse: (frontmatter["when_to_use"] as string) ?? undefined,
    embeddingText: (frontmatter["embedding_text"] as string) ?? undefined,
    evalCases: parseEvalCases(frontmatter["eval_cases"] ?? frontmatter["evalCases"]),
  };
}

/**
 * T-722 — enforce frontmatter field caps + tag-array shape independently of
 * the local-fs path's filesystem checks. Reused by `validateSkillMeta`
 * (local-fs imports) and by the importer for git/http imports, which never
 * touch a local dirPath but still must not bypass T-705's caps.
 */
export function validateSkillMetaFields(meta: SkillFrontmatter): void {
  if (meta.name.length > MAX_NAME_LENGTH) {
    throw new Error(`Skill name exceeds max length (${MAX_NAME_LENGTH})`);
  }
  if (meta.version !== undefined && meta.version.length > MAX_VERSION_LENGTH) {
    throw new Error(`Skill version exceeds max length (${MAX_VERSION_LENGTH})`);
  }
  if (meta.description !== undefined && meta.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Skill description exceeds max length (${MAX_DESCRIPTION_LENGTH})`);
  }
  if (meta.category !== undefined && meta.category.length > MAX_CATEGORY_LENGTH) {
    throw new Error(`Skill category exceeds max length (${MAX_CATEGORY_LENGTH})`);
  }
  if (meta.tags !== undefined) {
    if (!Array.isArray(meta.tags)) {
      throw new Error(`Skill tags must be an array of strings`);
    }
    if (meta.tags.length > MAX_TAGS_COUNT) {
      throw new Error(`Skill tags exceed max count (${MAX_TAGS_COUNT})`);
    }
    for (const tag of meta.tags) {
      if (typeof tag !== "string") {
        throw new Error(`Skill tag must be a string`);
      }
      if (tag.length > MAX_TAG_LENGTH) {
        throw new Error(`Skill tag exceeds max length (${MAX_TAG_LENGTH})`);
      }
    }
  }
  // P1-11 — retrieval-signal field validation.
  if (meta.triggers !== undefined) {
    if (!Array.isArray(meta.triggers)) {
      throw new Error(`Skill triggers must be an array of strings`);
    }
    if (meta.triggers.length > MAX_TRIGGERS_COUNT) {
      throw new Error(`Skill triggers exceed max count (${MAX_TRIGGERS_COUNT})`);
    }
    for (const trigger of meta.triggers) {
      if (typeof trigger !== "string") {
        throw new Error(`Skill trigger must be a string`);
      }
      if (trigger.length > MAX_TRIGGER_LENGTH) {
        throw new Error(`Skill trigger exceeds max length (${MAX_TRIGGER_LENGTH})`);
      }
    }
  }
  if (meta.whenToUse !== undefined) {
    if (typeof meta.whenToUse !== "string") {
      throw new Error(`Skill when_to_use must be a string`);
    }
    if (meta.whenToUse.length > MAX_WHEN_TO_USE_LENGTH) {
      throw new Error(`Skill when_to_use exceeds max length (${MAX_WHEN_TO_USE_LENGTH})`);
    }
  }
  if (meta.embeddingText !== undefined) {
    if (typeof meta.embeddingText !== "string") {
      throw new Error(`Skill embedding_text must be a string`);
    }
    if (meta.embeddingText.length > MAX_EMBEDDING_TEXT_LENGTH) {
      throw new Error(`Skill embedding_text exceeds max length (${MAX_EMBEDDING_TEXT_LENGTH})`);
    }
  }
  // P1-12 stage 1 — eval-case shape + caps. Non-fatal (info nudge) when the
  // field is absent; we only reject malformed shapes and cap violations here.
  if (meta.evalCases !== undefined) {
    validateEvalCases(meta.evalCases);
  }
}

/**
 * P1-12 stage 1 — strict shape + caps + per-case sanity check. Throws on the
 * first violation so the importer surfaces one clear error instead of a flood.
 */
export function validateEvalCases(raw: unknown): void {
  if (!Array.isArray(raw)) {
    throw new Error(`Skill eval_cases must be an array of case objects`);
  }
  if (raw.length > MAX_EVAL_CASES) {
    throw new Error(`Skill eval_cases exceed max count (${MAX_EVAL_CASES})`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      throw new Error(`Skill eval_cases[${i}] must be an object`);
    }
    const ec = c as SkillEvalCase;
    if (typeof ec.name !== "string" || ec.name.length === 0) {
      throw new Error(`Skill eval_cases[${i}].name is required and must be a non-empty string`);
    }
    if (ec.name.length > MAX_EVAL_NAME_LENGTH) {
      throw new Error(`Skill eval_cases[${i}].name exceeds max length (${MAX_EVAL_NAME_LENGTH})`);
    }
    if (seen.has(ec.name)) {
      throw new Error(`Skill eval_cases[${i}].name "${ec.name}" is duplicated within the skill`);
    }
    seen.add(ec.name);
    if (typeof ec.input !== "string" || ec.input.length === 0) {
      throw new Error(`Skill eval_cases[${i}].input is required and must be a non-empty string`);
    }
    if (ec.input.length > MAX_EVAL_INPUT_LENGTH) {
      throw new Error(`Skill eval_cases[${i}].input exceeds max length (${MAX_EVAL_INPUT_LENGTH})`);
    }
    validateExpectList(ec.expectedTools, `eval_cases[${i}].expected_tools`);
    validateExpectList(ec.expectedOutputContains, `eval_cases[${i}].expected_output_contains`);
    validateExpectList(ec.expectedOutputNotContains, `eval_cases[${i}].expected_output_not_contains`);
    const hasAnyExpect =
      (ec.expectedTools && ec.expectedTools.length > 0) ||
      (ec.expectedOutputContains && ec.expectedOutputContains.length > 0) ||
      (ec.expectedOutputNotContains && ec.expectedOutputNotContains.length > 0);
    if (!hasAnyExpect) {
      throw new Error(
        `Skill eval_cases[${i}] must declare at least one of expected_tools / expected_output_contains / expected_output_not_contains — a case with no expectations cannot fail`,
      );
    }
  }
}

function validateExpectList(list: string[] | undefined, label: string): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    throw new Error(`Skill ${label} must be an array of strings`);
  }
  if (list.length > MAX_EVAL_EXPECT_ENTRIES) {
    throw new Error(`Skill ${label} exceed max count (${MAX_EVAL_EXPECT_ENTRIES})`);
  }
  for (const entry of list) {
    if (typeof entry !== "string") {
      throw new Error(`Skill ${label} entries must be strings`);
    }
    if (entry.length === 0) {
      throw new Error(`Skill ${label} entries must be non-empty strings`);
    }
    if (entry.length > MAX_EVAL_EXPECT_LENGTH) {
      throw new Error(`Skill ${label} entry exceeds max length (${MAX_EVAL_EXPECT_LENGTH})`);
    }
  }
}

/**
 * Validate skill metadata against actual files in directory
 */
export function validateSkillMeta(meta: SkillFrontmatter, dirPath: string): void {
  const entryRel = meta.entry ?? "SKILL.md";
  // T-601 — entry must resolve inside the skill root.
  const entryPath = safeJoin(dirPath, entryRel);
  if (!existsSync(entryPath)) {
    throw new Error(`Entry file not found: ${entryRel}`);
  }

  // T-705 — enforce field length / count caps so a malicious package cannot
  // smuggle arbitrarily large strings through the importer into SQLite + the
  // listing API response.
  validateSkillMetaFields(meta);
}

/**
 * Read all files from a skill directory.
 * If meta.files is specified, only those files are read.
 */
export function readSkillFiles(dirPath: string, meta?: SkillFrontmatter): SkillFileInput[] {
  const files: SkillFileInput[] = [];
  const logger = getLogger();
  let totalBytes = 0;

  // T-601 — share caps with both code paths.
  const pushFile = (relPath: string, buffer: Buffer) => {
    if (files.length >= MAX_FILES_PER_PACKAGE) {
      throw new Error(`Skill package exceeds max file count (${MAX_FILES_PER_PACKAGE})`);
    }
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_BYTES_PER_PACKAGE) {
      throw new Error(`Skill package exceeds max total size (${MAX_BYTES_PER_PACKAGE} bytes)`);
    }
    files.push({ path: relPath, buffer });
  };

  function walk(currentDir: string, relativeDir: string, depth: number): void {
    if (depth > MAX_WALK_DEPTH) {
      throw new Error(`Skill package directory nesting exceeds max depth (${MAX_WALK_DEPTH})`);
    }
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if ([".git", "node_modules"].includes(entry.name)) continue;

      const fullPath = join(currentDir, entry.name);
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      // T-601 — never follow symlinks. lstat avoids the readdir-isSymbolicLink
      // edge case on filesystems that don't populate the dirent flag.
      let lst;
      try {
        lst = lstatSync(fullPath);
      } catch (err) {
        logger.warn({ err, path: fullPath }, "skill-import: lstat failed, skipping entry");
        continue;
      }
      if (lst.isSymbolicLink()) {
        logger.warn({ path: fullPath }, "skill-import: refusing to follow symlink");
        continue;
      }

      if (lst.isDirectory()) {
        walk(fullPath, relPath, depth + 1);
      } else if (lst.isFile()) {
        const buffer = readFileSync(fullPath);
        pushFile(relPath, buffer);
      }
    }
  }

  if (meta?.files && meta.files.length > 0) {
    for (const filePath of meta.files) {
      // T-601 — refuse meta-declared paths that escape the skill root.
      const fullPath = safeJoin(dirPath, filePath);
      // Reject symlinks pointing outside the package even if declared.
      if (!existsSync(fullPath)) continue;
      const lst = lstatSync(fullPath);
      if (lst.isSymbolicLink()) {
        getLogger().warn({ path: fullPath }, "skill-import: refusing meta.files entry that is a symlink");
        continue;
      }
      if (statSync(fullPath).isFile()) {
        const buffer = readFileSync(fullPath);
        pushFile(filePath, buffer);
      }
    }
  } else {
    walk(dirPath, "", 0);
  }

  return files;
}

/**
 * Extract YAML frontmatter from SKILL.md content
 */
export function extractFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  try {
    const parsed = yaml.load(match[1], { schema: yaml.FAILSAFE_SCHEMA });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown>, body: match[2] };
    }
    return { frontmatter: {}, body: match[2] };
  } catch (err) {
    getLogger().debug({ err }, "Failed to parse SKILL.md frontmatter as YAML");
    return { frontmatter: {}, body: content };
  }
}

/**
 * Extract description from SKILL.md (first paragraph after heading)
 */
export function extractDescription(content: string): string {
  const { body } = extractFrontmatter(content);
  // Find first paragraph (text between headings)
  const paragraphs = body.split(/\n\s*\n/).filter(p => !p.startsWith("#") && p.trim().length > 0);
  if (paragraphs.length > 0) {
    return paragraphs[0].trim().slice(0, 200);
  }
  return "";
}

/**
 * Generate slug from name (kebab-case)
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Compute SHA-256 content hash for a set of skill files
 */
export function computeContentHash(files: SkillFileInput[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash("sha256");
  for (const f of sorted) {
    hash.update(f.path);
    hash.update(f.buffer);
  }
  return `sha256:${hash.digest("hex")}`;
}
