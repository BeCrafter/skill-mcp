import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { getLogger } from "./logger.js";
import { InvalidPathError } from "./errors.js";
import type { SkillFrontmatter, SkillFileInput } from "../types/index.js";

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
  };
}

/** @deprecated Use parseSkillMeta instead */
export const parseManifest = parseSkillMeta;

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

/** @deprecated Use validateSkillMeta instead */
export const validateManifest = validateSkillMeta;

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
