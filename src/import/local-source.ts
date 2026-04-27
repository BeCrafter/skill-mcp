import { existsSync } from "node:fs";
import type { SkillFileInput } from "../types/index.js";
import { parseManifest, validateManifest, readSkillFiles } from "../utils/manifest.js";

export class LocalSourceResolver {
  /**
   * Resolve skill files from a local directory path
   */
  resolve(dirPath: string): SkillFileInput[] {
    if (!existsSync(dirPath)) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    const manifest = parseManifest(dirPath);
    validateManifest(manifest, dirPath);
    return readSkillFiles(dirPath, manifest);
  }

  /**
   * Parse manifest from a local directory (for preview)
   */
  parseManifest(dirPath: string) {
    if (!existsSync(dirPath)) {
      throw new Error(`Directory not found: ${dirPath}`);
    }
    return parseManifest(dirPath);
  }
}
