import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { LocalFileSystemProvider } from "../../storage/local-fs.provider.js";
import { CompositeCacheProvider } from "../../cache/composite.provider.js";
import { SkillImporter } from "../../import/importer.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { SkillFileRepository } from "../../db/repositories/skill-file.repository.js";
import { getLogger } from "../../utils/logger.js";
import type { ImportOptions } from "../../types/index.js";

export async function importAction(
  source: string,
  options: ImportOptions,
): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const skillRepo = new SkillRepository(db);
  const skillFileRepo = new SkillFileRepository(db);
  const cache = new CompositeCacheProvider({ memory: config.cache.memory, file: config.cache.file });
  const basePath = config.storage.type === "local-fs" ? config.storage.basePath : "./data/skills";
  const storage = new LocalFileSystemProvider(basePath);
  const logger = getLogger();

  const importer = new SkillImporter(storage, skillRepo, skillFileRepo, cache, logger);

  try {
    const result = await importer.import(source, options);
    console.log(`✓ ${result.action === "created" ? "Created" : "Updated"} skill:`);
    console.log(`  Slug: ${result.slug}`);
    console.log(`  Name: ${result.name}`);
    console.log(`  Version: ${result.version}`);
    console.log(`  Files: ${result.fileCount}`);
    if (result.category) console.log(`  Category: ${result.category}`);
    if (result.tags?.length) console.log(`  Tags: ${result.tags.join(", ")}`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`✗ ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
