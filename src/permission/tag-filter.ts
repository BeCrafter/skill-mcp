import type { SkillMeta, RequestContext } from "../types/index.js";
import { metrics } from "../telemetry/metrics.js";

interface IPermissionFilter {
  filter(skills: SkillMeta[]): Promise<SkillMeta[]>;
}

const NON_ADMIN_VISIBLE_STATUSES: ReadonlySet<string> = new Set(["published", "deprecated"]);

export class TagPermissionFilter implements IPermissionFilter {
  constructor(private readonly context: RequestContext) {}

  async filter(skills: SkillMeta[]): Promise<SkillMeta[]> {
    const allowed: SkillMeta[] = [];
    for (const skill of skills) {
      if (this.canAccess(skill)) allowed.push(skill);
      else metrics.permissionDenials.inc({ visibility: skill.visibility ?? "private" });
    }
    return allowed;
  }

  private isAdmin(): boolean {
    return this.context.isAuthenticated && (this.context.userType === "admin" || this.context.userType === "superadmin");
  }

  canAccess(skill: SkillMeta): boolean {
    if (!this.isAdmin() && !NON_ADMIN_VISIBLE_STATUSES.has(skill.status ?? "draft")) return false;
    if (skill.visibility === "public") return true;
    if (!this.context.isAuthenticated) return false;
    if (skill.visibility === "internal") return true;
    const skillTags = Array.isArray(skill.tags) ? skill.tags : [];
    return skillTags.length === 0 || skillTags.some((tag) => this.context.tags.has(tag));
  }
}
