import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
export async function infoAction(slug: string): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);

  const skill = await repo.findBySlug(slug);
  if (!skill) {
    console.error(`Skill not found: ${slug}`);
    process.exit(1);
  }

  console.log(`Slug: ${skill.slug}`);
  console.log(`Name: ${skill.name}`);
  if (skill.displayName) console.log(`Display: ${skill.displayName}`);
  console.log(`Version: ${skill.version}`);
  console.log(`Status: ${skill.status}`);
  console.log(`Visibility: ${skill.visibility}`);
  if (skill.description) console.log(`Description: ${skill.description}`);
  if (skill.category) console.log(`Category: ${skill.category}`);
  if (skill.tags.length) console.log(`Tags: ${skill.tags.join(", ")}`);
  if (Object.keys(skill.attributes).length) console.log(`Attributes: ${JSON.stringify(skill.attributes)}`);
  console.log(`Storage: ${skill.storagePath}`);
  console.log(`Entry: ${skill.entryFile}`);
  console.log(`Hash: ${skill.contentHash ?? "N/A"}`);
  console.log(`Created: ${new Date(skill.createdAt).toISOString()}`);
  console.log(`Updated: ${new Date(skill.updatedAt).toISOString()}`);
}
