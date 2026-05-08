import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { LocalFileSystemProvider } from "../../storage/local-fs.provider.js";
import { CompositeCacheProvider } from "../../cache/composite.provider.js";
import { SkillImporter } from "../../import/importer.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { SkillFileRepository } from "../../db/repositories/skill-file.repository.js";
import { SkillVersionRepository } from "../../db/repositories/skill-version.repository.js";
import { DomainEventBus } from "../../events/event-bus.js";
import { setupCacheSubscribers } from "../../events/cache-subscriber.js";
import { createLogger, setLogger } from "../../utils/logger.js";
import { c, badge, detail, ok, fail, infoBox } from "../ui.js";
import { DuplicateSkillNameError } from "../../utils/errors.js";
import type { ImportOptions } from "../../types/index.js";

export async function importAction(
  source: string,
  options: ImportOptions,
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
  const eventBus = new DomainEventBus();
  setupCacheSubscribers(eventBus, cache);

  const importer = new SkillImporter(storage, skillRepo, skillFileRepo, cache, logger, eventBus, versionRepo);

  try {
    const r = await importer.import(source, options);
    const verb = r.action === "created" ? "Created" : "Updated";
    ok(`${c.bold(verb)}  ${c.boldCyan(r.slug)}  ${c.dim("v" + r.version)}  ${c.dim("·")}  ${c.dim(r.fileCount + " files")}`);
    console.log(detail("id",     r.id));
    if (r.action === "created") console.log(detail("slug",   r.slug));
    if (r.category)             console.log(detail("category", r.category));
    if (Array.isArray(r.tags) && r.tags.length)  console.log(detail("tags", r.tags.join(", ")));
    console.log(detail("status", badge("published")));
    console.log();
  } catch (error: unknown) {
    if (error instanceof DuplicateSkillNameError) {
      console.error(`\n  ${c.boldRed("✗")}  ${c.bold("Duplicate skill found")}\n`);
      infoBox(
        `Skill "${c.bold(error.skillName)}" already exists`,
        error.existing.map(s => ({ key: s.slug, value: `v${s.version}` }))
      );
      console.error(`\n     ${c.dim("Options:")}\n`);
      console.error(`     ${c.cyan("--overwrite")}      Replace the first existing version`);
      console.error(`     ${c.cyan("--id <id>")}       Update a specific version by ID`);
      console.error(`     ${c.cyan("--allow-duplicate")}  Create as new variant with auto-generated slug\n`);
      process.exit(1);
    } else if (error instanceof Error) {
      fail(error.message);
      process.exit(1);
    }
    throw error;
  }
}
