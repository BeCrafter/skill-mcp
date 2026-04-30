import type { IPermissionFilter } from "./filter.interface.js";
import type { SkillMeta, RequestContext } from "../types/index.js";

export class TagPermissionFilter implements IPermissionFilter {
  constructor(private context: RequestContext) {}

  async filter(skills: SkillMeta[]): Promise<SkillMeta[]> {
    return skills.filter(skill => this.canAccess(skill));
  }

  async check(_skillId: string): Promise<boolean> {
    // Without skill metadata, cannot check tags — use canAccess(skillMeta) instead
    return true;
  }

  canAccess(skill: SkillMeta): boolean {
    const skillTags = Array.isArray(skill.tags) ? skill.tags : [];
    if (skillTags.length === 0) return true;
    if (!this.context.isAuthenticated) return false;
    return skillTags.some(t => this.context.tags.has(t));
  }
}
