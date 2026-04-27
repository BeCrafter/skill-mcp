import type { IPermissionFilter } from "./filter.interface.js";
import type { SkillMeta } from "../types/index.js";

/**
 * No-op permission filter for MVP.
 * Allows all skills through.
 */
export class NoopPermissionFilter implements IPermissionFilter {
  async filter(skills: SkillMeta[]): Promise<SkillMeta[]> {
    return skills;
  }

  async check(_skillId: string): Promise<boolean> {
    return true;
  }
}
