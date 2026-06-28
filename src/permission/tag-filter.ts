import type { SkillMeta, RequestContext } from "../types/index.js";
import { metrics } from "../telemetry/metrics.js";
import { withSpan } from "../telemetry/spans.js";

interface IPermissionFilter {
  filter(skills: SkillMeta[]): Promise<SkillMeta[]>;
}

// P0-9 — non-admin callers see published skills (active) and deprecated skills
// (still visible during the deprecation window so existing integrations keep
// working with a soft warning surfaced by the SDK). Draft and archived states
// are hidden so unfinished or retired skills don't leak into the catalog.
const NON_ADMIN_VISIBLE_STATUSES: ReadonlySet<string> = new Set(["published", "deprecated"]);

export class TagPermissionFilter implements IPermissionFilter {
  constructor(private context: RequestContext) {}

  async filter(skills: SkillMeta[]): Promise<SkillMeta[]> {
    // P0-6 — `perm.filter` span (§17.6). Records input/output cardinalities
    // so a sudden drop ratio (many skills → few allowed) shows up in traces.
    return withSpan(
      "perm.filter",
      { ctx: this.context, attributes: { "perm.input_count": skills.length, "perm.is_admin": this.isAdmin() } },
      async () => {
        const allowed: SkillMeta[] = [];
        for (const skill of skills) {
          if (this.canAccess(skill)) {
            allowed.push(skill);
          } else {
            metrics.permissionDenials.inc({ visibility: skill.visibility ?? "private" });
          }
        }
        return allowed;
      },
    );
  }

  /**
   * P0-9 — admin callers (userType=admin or superadmin) see every
   * lifecycle state so they can manage drafts and archives. Everyone else
   * sees only published + deprecated (see NON_ADMIN_VISIBLE_STATUSES). The
   * status check runs BEFORE the visibility check so an unauthenticated
   * caller asking for a draft public skill still gets denied (consistent
   * with "drafts are not browseable").
   */
  private isAdmin(): boolean {
    if (!this.context.isAuthenticated) return false;
    return this.context.userType === "admin" || this.context.userType === "superadmin";
  }

  canAccess(skill: SkillMeta): boolean {
    if (!this.isAdmin()) {
      const status = skill.status ?? "draft";
      if (!NON_ADMIN_VISIBLE_STATUSES.has(status)) return false;
    }
    // Public skills are visible to everyone, including anonymous callers.
    if (skill.visibility === "public") return true;
    // private/internal: must be authenticated to see at all.
    // Unauthenticated callers cannot see private/internal skills regardless
    // of any tags they may carry. This is the primary access control boundary
    // for the data visibility layer.
    if (!this.context.isAuthenticated) return false;
    // internal: any authenticated user; tag check only applies to private.
    if (skill.visibility === "internal") return true;
    // private (default): empty tags → any authenticated user; otherwise tag intersection.
    const skillTags = Array.isArray(skill.tags) ? skill.tags : [];
    if (skillTags.length === 0) return true;
    return skillTags.some(t => this.context.tags.has(t));
  }
}
