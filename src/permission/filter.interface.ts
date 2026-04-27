import type { SkillMeta } from "../types/index.js";

export interface IPermissionFilter {
  /** Filter a list of skills to only those the user has access to */
  filter(skills: SkillMeta[]): Promise<SkillMeta[]>;

  /** Check if a specific skill is accessible */
  check(skillId: string): Promise<boolean>;
}
