import type { Logger } from "pino";
import type { ISkillProvider } from "../provider/interface.js";
import type { ICacheProvider } from "../cache/provider.interface.js";
import type { IPermissionFilter } from "../permission/filter.interface.js";
import type { AccessLogService } from "./access-log.service.js";
import { scanForInjection } from "../utils/security.js";
import { PermissionDeniedError, SkillNotFoundError } from "../utils/errors.js";
import type { SkillMeta, SkillFileContent } from "../types/index.js";

export class SkillService {
  private accessLog: AccessLogService | null;

  constructor(
    private skillProvider: ISkillProvider,
    private cache: ICacheProvider,
    private permissionFilter: IPermissionFilter,
    private logger: Logger,
    accessLog?: AccessLogService,
  ) {
    this.accessLog = accessLog ?? null;
  }

  /** Build the skills index for MCP instructions (flat list, no grouping) */
  async listSkillsIndex(): Promise<string> {
    const start = Date.now();

    let skills = await this.skillProvider.listSkills();
    skills = await this.permissionFilter.filter(skills);

    const sorted = skills
      .filter(s => s.status === "published")
      .sort((a, b) => a.slug.localeCompare(b.slug));

    const lines = sorted.map(s => {
      const desc = (s.description ?? "").length > 80
        ? s.description.slice(0, 77) + "..."
        : s.description;
      return `    - ${s.slug} [id:${s.id}]: ${desc}`;
    });

    // Access log
    if (this.accessLog && sorted.length > 0) {
      this.accessLog.log({
        skillId: sorted[0].id,
        skillSlug: "__index__",
        action: "list",
        latencyMs: Date.now() - start,
      }).catch(() => {});
    }

    return lines.join("\n");
  }

  private async resolveSkill(identifier: string): Promise<SkillMeta | null> {
    // UUID format: search by id first, fallback to slug
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    if (isUuid) {
      const byId = await this.skillProvider.getSkillMetaById(identifier);
      if (byId) return byId;
    }
    return this.skillProvider.getSkillMeta(identifier);
  }

  /** View skill entry (SKILL.md) with activation guidance injection */
  async viewSkillEntry(identifier: string): Promise<string> {
    const start = Date.now();

    const skill = await this.resolveSkill(identifier);
    if (!skill) throw new SkillNotFoundError(identifier);

    const allowed = await this.permissionFilter.check(skill.id);
    if (!allowed) throw new PermissionDeniedError(identifier);

    const content = await this.skillProvider.getSkillEntry(skill.slug);

    // Security scan
    const scanResult = scanForInjection(content);
    if (!scanResult.safe) {
      this.logger.warn({ identifier, issues: scanResult.issues }, "Skill content contains suspicious patterns");
    }

    const fileTree = await this.skillProvider.getSkillFileTree(skill.slug);
    const filePaths = fileTree
      .filter(f => f.path !== "SKILL.md" && f.path !== "manifest.json")
      .map(f => f.path)
      .join(", ");

    // Access log
    if (this.accessLog) {
      this.accessLog.log({
        skillId: skill.id,
        skillSlug: skill.slug,
        action: "view_entry",
        latencyMs: Date.now() - start,
      }).catch(() => {});
    }

    return [
      `[SYSTEM: The user is using the "${skill.slug}" skill. Below are the full instructions. Follow them strictly.]`,
      "",
      content,
      "",
      filePaths ? `[Available files: ${filePaths}]` : "",
      filePaths ? `[Tip: Use skill_file("${skill.slug}", ["path1", "path2"]) to batch-load files]` : "",
    ].filter(Boolean).join("\n");
  }

  /** Read skill files (batch) */
  async readSkillFiles(identifier: string, filePaths: string[]): Promise<SkillFileContent[]> {
    const start = Date.now();

    const skill = await this.resolveSkill(identifier);
    if (!skill) throw new SkillNotFoundError(identifier);

    const allowed = await this.permissionFilter.check(skill.id);
    if (!allowed) throw new PermissionDeniedError(identifier);

    const results = await this.skillProvider.getSkillFiles(skill.slug, filePaths);

    // Access log
    if (this.accessLog) {
      this.accessLog.log({
        skillId: skill.id,
        skillSlug: skill.slug,
        action: "read_files",
        filePaths,
        latencyMs: Date.now() - start,
      }).catch(() => {});
    }

    return results;
  }

  /** Check if a skill exists */
  async skillExists(identifier: string): Promise<boolean> {
    const skill = await this.resolveSkill(identifier);
    return !!skill;
  }

  /** Get skill metadata */
  async getSkillMeta(identifier: string): Promise<SkillMeta | null> {
    return this.resolveSkill(identifier);
  }
}
