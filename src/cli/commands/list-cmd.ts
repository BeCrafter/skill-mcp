import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";

export async function listAction(options: { name?: string; tags?: string }): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);

  const skills = options.name
    ? await repo.findByName(options.name)
    : await repo.findAll(options.tags ? { tags: options.tags.split(",") } : undefined);

  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }

  console.log(`Found ${skills.length} skill(s):\n`);
  for (const s of skills) {
    console.log(`  ${s.slug}  ${s.name}  v${s.version}  [${s.status}]`);
    if (s.description) console.log(`    ${s.description}`);
    if (s.category) console.log(`    category: ${s.category}`);
    if (s.tags.length) console.log(`    tags: ${s.tags.join(", ")}`);
    console.log();
  }
}
