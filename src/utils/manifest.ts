import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getLogger } from "./logger.js";
import type { SkillFrontmatter, SkillFileInput } from "../types/index.js";

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
 * Validate skill metadata against actual files in directory
 */
export function validateSkillMeta(meta: SkillFrontmatter, dirPath: string): void {
  const entryPath = join(dirPath, meta.entry ?? "SKILL.md");
  if (!existsSync(entryPath)) {
    throw new Error(`Entry file not found: ${meta.entry ?? "SKILL.md"}`);
  }
}

/** @deprecated Use validateSkillMeta instead */
export const validateManifest = validateSkillMeta;

/**
 * Read all files from a skill directory.
 * If meta.files is specified, only those files are read.
 */
export function readSkillFiles(dirPath: string, meta?: SkillFrontmatter): SkillFileInput[] {
  const files: SkillFileInput[] = [];

  function walk(currentDir: string, relativeDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if ([".git", "node_modules"].includes(entry.name)) continue;

      const fullPath = join(currentDir, entry.name);
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else {
        const buffer = readFileSync(fullPath);
        files.push({ path: relPath, buffer });
      }
    }
  }

  if (meta?.files && meta.files.length > 0) {
    for (const filePath of meta.files) {
      const fullPath = join(dirPath, filePath);
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        const buffer = readFileSync(fullPath);
        files.push({ path: filePath, buffer });
      }
    }
  } else {
    walk(dirPath, "");
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
    const yamlContent = match[1];
    const frontmatter: Record<string, unknown> = {};
    for (const line of yamlContent.split("\n")) {
      const kvMatch = line.match(/^(\w[\w-]*):\s*(.+)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        // Handle array values (comma-separated)
        if (value.startsWith("[") && value.endsWith("]")) {
          frontmatter[key] = value.slice(1, -1).split(",").map(s => s.trim());
        } else {
          frontmatter[key] = value.trim();
        }
      }
    }
    return { frontmatter, body: match[2] };
  } catch {
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
