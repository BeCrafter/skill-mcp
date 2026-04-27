import { createInterface } from "node:readline/promises";
import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { LocalFileSystemProvider } from "../../storage/local-fs.provider.js";
import { CompositeCacheProvider } from "../../cache/composite.provider.js";

export async function removeAction(slug: string, options: { force?: boolean }): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);

  const skill = await repo.findBySlug(slug);
  if (!skill) {
    console.error(`Skill not found: ${slug}`);
    process.exit(1);
  }

  if (!options.force) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Remove skill "${slug}" (${skill.version})? [y/N] `);
    rl.close();
    if (answer.toLowerCase() !== "y") {
      console.log("Cancelled.");
      return;
    }
  }

  // Remove from DB
  await repo.delete(slug);

  // Remove files from storage
  if (config.storage.type === "local-fs") {
    const storage = new LocalFileSystemProvider(config.storage.basePath);
    await storage.deleteDir(skill.storagePath);
    console.log(`  Removed storage: ${skill.storagePath}`);
  }

  // Clear cache for this skill
  const cache = new CompositeCacheProvider({ memory: config.cache.memory, file: config.cache.file });
  await cache.clearByPrefix(`skill:entry:${slug}`);
  await cache.clearByPrefix(`skill:file:${slug}`);

  console.log(`Skill "${slug}" removed.`);
}
