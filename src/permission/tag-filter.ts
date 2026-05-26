import type { IPermissionFilter } from "./filter.interface.js";
import type { SkillMeta, RequestContext } from "../types/index.js";
import { metrics } from "../telemetry/metrics.js";

export class TagPermissionFilter implements IPermissionFilter {
  constructor(private context: RequestContext) {}

  async filter(skills: SkillMeta[]): Promise<SkillMeta[]> {
    const allowed: SkillMeta[] = [];
    for (const skill of skills) {
      if (this.canAccess(skill)) {
        allowed.push(skill);
      } else {
        metrics.permissionDenials.inc({ visibility: skill.visibility ?? "private" });
      }
    }
    return allowed;
  }

  async check(_skillId: string): Promise<boolean> {
    // Without skill metadata, cannot check tags — use canAccess(skillMeta) instead
    return true;
  }

  canAccess(skill: SkillMeta): boolean {
    // Public skills are visible to everyone, including anonymous callers.
    if (skill.visibility === "public") return true;
    // private/internal: must be authenticated to see at all.
    // NOTE: this guard is what limits the SKILL_MCP_ADMIN_AUTH_OPTIONAL legacy
    // escape hatch (see src/http/middleware/admin-auth.ts) — it produces a
    // context with `admin:write` tag but `isAuthenticated=false`, so even if
    // such a context reaches this filter it cannot read private/internal
    // skills regardless of tag intersection.
    if (!this.context.isAuthenticated) return false;
    // internal: any authenticated user; tag check only applies to private.
    if (skill.visibility === "internal") return true;
    // private (default): empty tags → any authenticated user; otherwise tag intersection.
    const skillTags = Array.isArray(skill.tags) ? skill.tags : [];
    if (skillTags.length === 0) return true;
    return skillTags.some(t => this.context.tags.has(t));
  }
}
