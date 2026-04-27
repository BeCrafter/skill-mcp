import type { IPermissionFilter } from "./filter.interface.js";
import type { SkillMeta } from "../types/index.js";

export interface GroupFilterOptions {
  /** User's assigned groups */
  userGroups: string[];
  /** Default if no groups match (default: true for public skills) */
  defaultAllow?: boolean;
}

/**
 * Group-based permission filter.
 * Filters skills based on assignedGroups field and user's groups.
 */
export class GroupPermissionFilter implements IPermissionFilter {
  private userGroups: Set<string>;
  private defaultAllow: boolean;

  constructor(options: GroupFilterOptions) {
    this.userGroups = new Set(options.userGroups);
    this.defaultAllow = options.defaultAllow ?? true;
  }

  async filter(skills: SkillMeta[]): Promise<SkillMeta[]> {
    return skills.filter(skill => this.canAccess(skill));
  }

  async check(skillId: string): Promise<boolean> {
    return true;
  }

  private canAccess(skill: SkillMeta): boolean {
    const groups = skill.assignedGroups ?? [];

    if (groups.length === 0) {
      return this.defaultAllow || skill.visibility === "public";
    }

    return groups.some(g => this.userGroups.has(g));
  }
}
