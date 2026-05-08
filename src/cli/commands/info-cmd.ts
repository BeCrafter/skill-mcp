import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { c, badge, kv, sep, fail, fmtDate } from "../ui.js";

export async function infoAction(slug: string): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);

  const skill = await repo.findBySlug(slug);
  if (!skill) {
    fail(`Skill not found: ${slug}`);
    process.exit(1);
  }

  const title = `${c.boldCyan(skill.slug)}  ${c.dim("v" + skill.version)}`;
  console.log(`\n  ${title}`);
  console.log(`  ${sep(52)}\n`);

  console.log(kv("slug",       skill.slug));
  if (skill.name !== skill.slug) console.log(kv("name", skill.name));
  if (skill.displayName)         console.log(kv("display",    skill.displayName));
  console.log(kv("status",     badge(skill.status)));
  console.log(kv("visibility", skill.visibility));
  if (skill.category) console.log(kv("category",   skill.category));
  if (skill.tags.length) console.log(kv("tags", skill.tags.join(", ")));
  console.log(kv("entry",      skill.entryFile));
  console.log(kv("storage",    skill.storagePath));
  console.log(kv("hash",       skill.contentHash ? skill.contentHash.slice(0, 16) + "…" : c.dim("N/A")));
  console.log(kv("created",    fmtDate(skill.createdAt)));
  console.log(kv("updated",    fmtDate(skill.updatedAt)));

  if (skill.description) {
    console.log();
    const words = skill.description.replace(/^["']|["']$/g, "").trim().split(" ");
    let line = "  ";
    for (const word of words) {
      if (line.length + word.length > 74) {
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
