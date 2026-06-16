import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { c, badge, kv, fail, fmtDate, section, maxLineWidth } from "../ui.js";

export async function infoAction(slug: string): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);

  const skill = await repo.findBySlug(slug);
  if (!skill) {
    fail(`Skill not found: ${slug}`, "Use `skill-mcp list` to see available skills");
    process.exit(1);
  }
  // Collect kv lines to compute section width
  const kvLines: string[] = [];
  kvLines.push(kv("slug", skill.slug));
  if (skill.name !== skill.slug) kvLines.push(kv("name", skill.name));
  if (skill.displayName) kvLines.push(kv("display", skill.displayName));
  kvLines.push(kv("status", badge(skill.status)));
  kvLines.push(kv("visibility", skill.visibility));
  if (skill.category) kvLines.push(kv("category", skill.category));
  if (Array.isArray(skill.tags) && skill.tags.length) kvLines.push(kv("tags", skill.tags.join(", ")));
  kvLines.push(kv("version", c.dim("v" + skill.version)));
  kvLines.push(kv("entry", skill.entryFile));
  kvLines.push(kv("storage", skill.storagePath));
  kvLines.push(kv("hash", skill.contentHash ? skill.contentHash.slice(0, 16) + "…" : c.dim("N/A")));
  kvLines.push(kv("created", fmtDate(skill.createdAt)));
  kvLines.push(kv("updated", fmtDate(skill.updatedAt)));

  console.log(section(skill.slug, undefined, maxLineWidth(...kvLines)));
  console.log();

  for (const line of kvLines) console.log(line);


  if (skill.description) {
    const desc = skill.description.replace(/^["']|["']$/g, "").trim();
    console.log();
    const words = desc.split(" ");
    let line = "  ";
    for (const word of words) {
      if (line.length + word.length > 44) {
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
