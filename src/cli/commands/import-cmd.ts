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
import { requireAuth, readCredentials } from "./auth-cmd.js";
import { getServerUrl, apiCall, uploadFile } from "../remote-client.js";

export async function importAction(
  source: string,
  options: ImportOptions & { serverUrl?: string },
): Promise<void> {
  const serverUrl = getServerUrl(options);

  if (serverUrl) {
    const creds = requireAuth();
    const isGitUrl = source.startsWith("http://") || source.startsWith("https://") || source.startsWith("git@");

    if (isGitUrl) {
      // Git URL: pass directly to server API (server clones the repo)
      const body: Record<string, unknown> = { source };
      if (options.category) body.category = options.category;
      if (options.tags) body.tags = options.tags;
      if (options.description) body.description = options.description;
      if (options.targetId) body.target_id = options.targetId;
      if (options.versionBump) body.version_bump = options.versionBump;
      if (options.overwrite) body.overwrite = options.overwrite;
      if (options.allowDuplicate) body.allow_duplicate = options.allowDuplicate;
      if (options.slug) body.slug = options.slug;
      if (options.branch) body.branch = options.branch;
      if (options.subDir) body.sub_dir = options.subDir;

      const result = await apiCall<{ id: string; slug: string; version: string; fileCount: number; action: string }>(
        serverUrl, "POST", "/api/admin/skills", { body, credentials: creds },
      );
      const verb = result.action === "created" ? "Created" : "Updated";
      ok(`${c.bold(verb)}  ${c.boldCyan(result.slug)}  ${c.dim("v" + result.version)}`);
    } else {
      // Local directory: pack as tar.gz and upload
      const { execSync } = await import("node:child_process");
      const { mkdtempSync, readFileSync, rmSync, existsSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      if (!existsSync(source)) {
        fail(`Source directory not found: ${source}`);
        process.exit(1);
      }

      const tmpDir = mkdtempSync(join(tmpdir(), "skill-mcp-import-"));
      const tarPath = join(tmpDir, "skill-package.tar.gz");

      try {
        execSync(`tar -czf "${tarPath}" -C "${source}" .`, { stdio: "pipe" });
        const fileBuffer = readFileSync(tarPath);

        const metadata: Record<string, unknown> = {};
        if (options.category) metadata.category = options.category;
        if (options.tags) metadata.tags = options.tags;
        if (options.description) metadata.description = options.description;
        if (options.targetId) metadata.target_id = options.targetId;
        if (options.versionBump) metadata.version_bump = options.versionBump;
        if (options.overwrite) metadata.overwrite = options.overwrite;
        if (options.allowDuplicate) metadata.allow_duplicate = options.allowDuplicate;
        if (options.slug) metadata.slug = options.slug;

        const result = await uploadFile<{ id: string; slug: string; version: string; fileCount: number; action: string }>(
          serverUrl, "/api/admin/skills/upload", fileBuffer, metadata, creds,
        );
        const verb = result.action === "created" ? "Created" : "Updated";
        ok(`${c.bold(verb)}  ${c.boldCyan(result.slug)}  ${c.dim("v" + result.version)}`);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
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
