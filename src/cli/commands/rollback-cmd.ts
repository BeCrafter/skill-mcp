import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { LocalFileSystemProvider } from "../../storage/local-fs.provider.js";
import { CompositeCacheProvider } from "../../cache/composite.provider.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { SkillVersionRepository } from "../../db/repositories/skill-version.repository.js";
import { LocalSkillProvider } from "../../provider/local.provider.js";
import { SkillFileRepository } from "../../db/repositories/skill-file.repository.js";
import { SkillService } from "../../services/skill.service.js";
import { createLogger, setLogger } from "../../utils/logger.js";
import { c, fail, kv, section, kvWidth, ok } from "../ui.js";
import { requireAuth } from "./auth-cmd.js";
import { getServerUrl, apiCall } from "../remote-client.js";

export async function rollbackAction(
  slug: string,
  options: { to: string; serverUrl?: string },
): Promise<void> {
  const serverUrl = getServerUrl(options);

  if (serverUrl) {
    const creds = requireAuth();
    await apiCall(serverUrl, "POST", `/api/admin/skills/${slug}/rollback`, {
      body: { version: options.to },
      credentials: creds,
    });
    ok(`Rolled back ${c.boldCyan(slug)} to v${options.to}`);
    return;
  }

  // Local mode
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
  const skillService = new SkillService(
    skillProvider, cache, logger,
    undefined, undefined, versionRepo, skillRepo, storage,
    undefined, skillFileRepo,
  );

  try {
    const skill = await skillRepo.findBySlug(slug);
    if (!skill) {
      fail(`Skill not found: ${slug}`, "Use `skill-mcp list` to see available skills");
      process.exit(1);
    }

    const version = versionRepo.findByVersion(skill.id, options.to);
    if (!version) {
      fail(`Version ${options.to} not found`, "Use `skill-mcp versions " + slug + "` to see available versions");
      process.exit(1);
    }

    console.log(`\n  ${c.dim("Rolling back")}  ${c.boldCyan(slug)}  ${c.dim(skill.version + " → " + options.to)}`);
    await skillService.rollbackToVersion(slug, options.to);

    console.log(section("rollback complete", undefined, kvWidth(12, "v" + options.to, String(version.fileCount))));
    console.log();
    console.log(kv("version", `${c.dim("v" + options.to)}`));
    console.log(kv("files restored", String(version.fileCount)));
    console.log();
  } catch (error: unknown) {
    if (error instanceof Error) {
      fail(error.message);
      process.exit(1);
    }
    throw error;
  }
}
