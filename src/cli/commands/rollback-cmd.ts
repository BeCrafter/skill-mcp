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
import { createLogger, setLogger } from "../../utils/logger.js";
import { c, detail, ok, fail } from "../ui.js";

export async function rollbackAction(
  slug: string,
  options: { to: string; bump?: "major" | "minor" | "patch" },
): Promise<void> {
  setLogger(createLogger("silent"));

  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const skillRepo = new SkillRepository(db);
  const skillFileRepo = new SkillFileRepository(db);
  const versionRepo = new SkillVersionRepository(db);
  const cache = new CompositeCacheProvider({ memory: config.cache.memory, file: config.cache.file });
  const basePath = config.storage.type === "local-fs" ? config.storage.basePath : "./data/skills";
  const storage = new LocalFileSystemProvider(basePath);
  const logger = createLogger("silent");
  const skillProvider = new LocalSkillProvider(storage, skillRepo, skillFileRepo, cache);
  const permissionFilter = new NoopPermissionFilter();
  const skillService = new SkillService(
    skillProvider, cache, permissionFilter, logger,
    undefined, undefined, versionRepo, skillRepo, storage,
  );

  try {
    const skill = await skillRepo.findBySlug(slug);
    if (!skill) {
      fail(`Skill not found: ${slug}`);
      process.exit(1);
    }

    const version = versionRepo.findByVersion(skill.id, options.to);
    if (!version) {
      fail(`Version ${options.to} not found`);
      process.exit(1);
    }

    console.log(`\n  ${c.dim("Rolling back")}  ${c.boldCyan(slug)}  ${c.dim(skill.version + " → " + options.to + " …")}`);
    await skillService.rollbackToVersion(slug, options.to, options.bump ?? "patch");

    const updated = await skillRepo.findBySlug(slug);
    const bump = options.bump ?? "patch";
    ok(`${c.bold("Rolled back")}  ${c.boldCyan(slug)}  ${c.dim("to v" + options.to)}`);
    console.log(detail("new version",   `${c.dim("v" + updated!.version)}  ${c.dim("(" + bump + " bump)")}`));
    console.log(detail("files restored", String(version.fileCount)));
    console.log();
  } catch (error: unknown) {
    if (error instanceof Error) {
      fail(error.message);
      process.exit(1);
    }
    throw error;
  }
}
