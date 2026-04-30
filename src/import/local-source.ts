import { existsSync } from "node:fs";
import type { SkillFileInput } from "../types/index.js";
import { parseSkillMeta, validateSkillMeta, readSkillFiles } from "../utils/manifest.js";

export class LocalSourceResolver {
  resolve(dirPath: string): SkillFileInput[] {
    if (!existsSync(dirPath)) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    const meta = parseSkillMeta(dirPath);
    validateSkillMeta(meta, dirPath);
    return readSkillFiles(dirPath, meta);
  }

  parseSkillMeta(dirPath: string) {
    if (!existsSync(dirPath)) {
      throw new Error(`Directory not found: ${dirPath}`);
    }
    return parseSkillMeta(dirPath);
  }
}
