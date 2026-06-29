import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { c, badge, kv, fail, fmtDate, section, maxLineWidth } from "../ui.js";
import { requireAuth } from "./auth-cmd.js";
import { getServerUrl, apiCall } from "../remote-client.js";

interface SkillDetail {
  slug: string; name: string; displayName?: string | null; status: string;
  visibility: string; category?: string | null; tags?: string[];
  version: string; entryFile: string; storagePath: string;
  contentHash?: string | null; description?: string | null;
  createdAt: number; updatedAt: number;
}

export async function infoAction(slug: string, opts: { serverUrl?: string } = {}): Promise<void> {
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const creds = requireAuth();
    const skill = await apiCall<SkillDetail>(
      serverUrl, "GET", `/api/admin/skills/${slug}`, { credentials: creds },
    );
    renderSkillInfo(skill);
    return;
  }

  // Local mode
  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);

  const skill = await repo.findBySlug(slug);
  if (!skill) {
    fail(`Skill not found: ${slug}`, "Use `skill-mcp list` to see available skills");
    process.exit(1);
  }
  renderSkillInfo(skill as SkillDetail);
}

function renderSkillInfo(skill: SkillDetail): void {
  // Basic info - compact
  const basicLines: string[] = [];
  basicLines.push(kv("Version", `v${skill.version}`));
  basicLines.push(kv("Status", badge(skill.status)));
  if (skill.visibility !== "private") basicLines.push(kv("Visibility", skill.visibility));
  if (skill.category) basicLines.push(kv("Category", skill.category));
  if (Array.isArray(skill.tags) && skill.tags.length) basicLines.push(kv("Tags", skill.tags.join(", ")));
  basicLines.push(kv("Updated", fmtDate(skill.updatedAt)));

  // Technical info
  const techLines: string[] = [];
  techLines.push(kv("Entry", skill.entryFile));
  techLines.push(kv("Storage", skill.storagePath));
  techLines.push(kv("Hash", skill.contentHash ? skill.contentHash.slice(0, 16) + "…" : c.dim("N/A")));
  techLines.push(kv("Created", fmtDate(skill.createdAt)));

  // Header
  console.log(section(skill.slug, undefined, maxLineWidth(...basicLines, ...techLines)));
  console.log();

  // Basic info
  for (const line of basicLines) console.log(line);

  // Technical section
  console.log();
  console.log(`    ${c.dim("Technical")}`);
  console.log(`    ${c.dim("─".repeat(20))}`);
  for (const line of techLines) console.log(line);

  // Description
  if (skill.description) {
    const desc = skill.description.replace(/^["']|["']$/g, "").trim();
    console.log();
    const termWidth = process.stdout.columns || 80;
    const maxWidth = Math.min(termWidth - 4, 120);
    const words = desc.split(" ");
    let line = "  ";
    for (const word of words) {
      if (line.length + word.length > maxWidth) {
        console.log(c.dim(line.trimEnd()));
        line = "  " + word + " ";
      } else {
        line += word + " ";
      }
    }
    if (line.trim()) console.log(c.dim(line.trimEnd()));
  }

  console.log();
}
