import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";

export async function searchAction(name: string): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);

  const results = await repo.findByName(name);
  if (results.length === 0) {
    console.log(`No skills found with name "${name}"`);
    return;
  }

  console.log(`Found ${results.length} skill(s) with name "${name}":\n`);
  for (const s of results) {
    console.log(`  ${s.slug}  v${s.version}  [${s.status}]`);
    if (s.description) console.log(`    ${s.description}`);
    console.log();
  }
}
