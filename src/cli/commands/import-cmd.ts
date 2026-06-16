import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { LocalFileSystemProvider } from "../../storage/local-fs.provider.js";
import { CompositeCacheProvider } from "../../cache/composite.provider.js";
import { SkillImporter } from "../../import/importer.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { SkillFileRepository } from "../../db/repositories/skill-file.repository.js";
import { SkillVersionRepository } from "../../db/repositories/skill-version.repository.js";
import { SkillEvalRepository } from "../../db/repositories/skill-eval.repository.js";
import { DomainEventBus } from "../../events/event-bus.js";
import { setupCacheSubscribers } from "../../events/cache-subscriber.js";
import { CacheEpochManager } from "../../cache/cache-epochs.js";
import { createLogger, setLogger } from "../../utils/logger.js";
import { c, badge, ok, fail, hint, kv } from "../ui.js";
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
  const evalRepo = new SkillEvalRepository(db);
  const cache = new CompositeCacheProvider({ memory: config.cache.memory, file: config.cache.file });
  const basePath = config.storage.type === "local-fs" ? config.storage.basePath : "./data/skills";
  const storage = new LocalFileSystemProvider(basePath);
  const logger = createLogger("silent");
  const eventBus = new DomainEventBus();
  const cacheEpochs = new CacheEpochManager();
  setupCacheSubscribers(eventBus, cache, cacheEpochs);

  const importer = new SkillImporter(storage, skillRepo, skillFileRepo, cache, logger, eventBus, versionRepo, undefined, evalRepo);

  try {
    const r = await importer.import(source, options);
    const verb = r.action === "created" ? "Created" : "Updated";
    ok(`${c.bold(verb)}  ${c.boldCyan(r.slug)}  ${c.dim("v" + r.version)}  ${c.dim("·")}  ${c.dim(r.fileCount + " files")}`, [
      { key: "id",     value: r.id },
      ...(r.action === "created" ? [{ key: "slug", value: r.slug }] : []),
      ...(r.category ? [{ key: "category", value: r.category }] : []),
      ...(Array.isArray(r.tags) && r.tags.length ? [{ key: "tags", value: r.tags.join(", ") }] : []),
      { key: "status", value: badge("published") },
    ]);
  } catch (error: unknown) {
    if (error instanceof DuplicateSkillNameError) {
      fail(`Duplicate skill found: "${error.skillName}" already exists`);
      for (const s of error.existing) console.log(kv(s.slug, `v${s.version}`));
      hint(`Use ${c.cyan("--overwrite")} to replace, or ${c.cyan("--allow-duplicate")} to create a new variant`);
      process.exit(1);
    } else if (error instanceof Error) {
      fail(error.message);
      process.exit(1);
    }
    throw error;
  }
}
