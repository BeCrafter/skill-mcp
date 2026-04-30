import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { LocalFileSystemProvider } from "../../storage/local-fs.provider.js";
import { CompositeCacheProvider } from "../../cache/composite.provider.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { SkillVersionRepository } from "../../db/repositories/skill-version.repository.js";
import { LocalSkillProvider } from "../../provider/local.provider.js";
import { SkillFileRepository } from "../../db/repositories/skill-file.repository.js";
import { NoopPermissionFilter } from "../../permission/noop-filter.js";
import { SkillService } from "../../services/skill.service.js";
import { getLogger } from "../../utils/logger.js";

export async function rollbackAction(
  slug: string,
  options: { to: string; bump?: "major" | "minor" | "patch" },
): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const skillRepo = new SkillRepository(db);
  const skillFileRepo = new SkillFileRepository(db);
  const versionRepo = new SkillVersionRepository(db);
  const cache = new CompositeCacheProvider({ memory: config.cache.memory, file: config.cache.file });
  const basePath = config.storage.type === "local-fs" ? config.storage.basePath : "./data/skills";
  const storage = new LocalFileSystemProvider(basePath);
  const logger = getLogger();
  const skillProvider = new LocalSkillProvider(storage, skillRepo, skillFileRepo, cache);
  const permissionFilter = new NoopPermissionFilter();
  const skillService = new SkillService(
    skillProvider,
    cache,
    permissionFilter,
    logger,
    undefined,
    undefined,
    versionRepo,
    skillRepo,
    storage,
  );

  try {
    const skill = await skillRepo.findBySlug(slug);
    if (!skill) {
      console.error(`✗ Skill not found: ${slug}`);
      process.exit(1);
    }

    const version = versionRepo.findByVersion(skill.id, options.to);
    if (!version) {
      console.error(`✗ Version ${options.to} not found`);
      process.exit(1);
    }

    console.log(`Rolling back "${slug}" from ${skill.version} to ${options.to}...`);
    await skillService.rollbackToVersion(slug, options.to, options.bump ?? "patch");

    const updated = await skillRepo.findBySlug(slug);
    console.log(`\n✓ Rolled back "${slug}" to version ${options.to}`);
    console.log(`  New version: ${updated!.version} (${options.bump ?? "patch"} bump)`);
    console.log(`  Files restored: ${version.fileCount}`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`✗ ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
