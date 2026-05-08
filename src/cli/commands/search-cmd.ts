import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { c, badge, truncate, sep, warn } from "../ui.js";

export async function searchAction(name: string): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);

  const results = await repo.findByName(name);

  if (results.length === 0) {
    warn(`No skills found matching "${name}"`);
    return;
  }

  const slugWidth = Math.min(Math.max(...results.map(s => s.slug.length), 16), 36);

  console.log(`\n  ${c.bold(String(results.length))} ${results.length === 1 ? "skill" : "skills"} matching ${c.boldCyan(name)}\n`);
  console.log(`  ${sep(slugWidth + 34)}\n`);

  for (const s of results) {
    const nameTag = s.name !== s.slug ? `  ${c.dim("[" + s.name + "]")}` : "";
    console.log(`  ${c.boldCyan(s.slug.padEnd(slugWidth))}  ${c.dim(("v" + s.version).padEnd(9))}  ${badge(s.status)}${nameTag}`);
    if (s.description) console.log(`  ${c.dim(truncate(s.description))}`);
    console.log();
  }
}
