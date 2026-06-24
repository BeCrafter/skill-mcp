import type { SkillMeta } from "../types/index.js";

export interface IPermissionFilter {
  /** Filter a list of skills to only those the user has access to */
  filter(skills: SkillMeta[]): Promise<SkillMeta[]>;
}
