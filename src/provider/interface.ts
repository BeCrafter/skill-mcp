import type { SkillMeta, SkillFileContent, FileInfo } from "../types/index.js";

export interface ISkillProvider {
  listSkills(options?: { category?: string; tags?: string[] }): Promise<SkillMeta[]>;
  getSkillMeta(slug: string): Promise<SkillMeta | null>;
  getSkillEntry(slug: string): Promise<string>;
  getSkillFiles(slug: string, filePaths: string[]): Promise<SkillFileContent[]>;
  getSkillFileTree(slug: string): Promise<FileInfo[]>;
  skillExists(slug: string): Promise<boolean>;
}
