import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { GitSourceResolver } from "../../import/git-source.js";
import { c, kv, section, ok, fail, warn, fmtDate } from "../ui.js";
import { requireAuth } from "./auth-cmd.js";
import { getServerUrl, apiCall } from "../remote-client.js";

interface SyncCheckResult {
  slug: string;
  currentVersion: string;
  hasUpdate: boolean;
  remoteHash?: string;
  localHash: string | null;
  importUrl: string | null;
  importBranch: string | null;
  importSubDir: string | null;
  importedAt: number | null;
}

export async function syncCheckAction(slug: string, opts: { serverUrl?: string } = {}): Promise<void> {
  requireAuth();
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const result = await apiCall<SyncCheckResult>(
      serverUrl, "GET", `/api/admin/skills/${slug}/sync/check`, { credentials: (await import("./auth-cmd.js")).readCredentials()! },
    );
    renderSyncCheck(result);
    return;
  }

  // Local mode
  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  const skillRepo = new SkillRepository(db);

  const skill = await skillRepo.findBySlug(slug);
  if (!skill) {
    fail(`Skill not found: ${slug}`, "Use `skill-mcp list` to see available skills");
    closeDatabase();
    process.exit(1);
  }

  if (!skill.importUrl) {
    fail(`Skill "${slug}" has no import source (was imported locally)`);
    closeDatabase();
    process.exit(1);
  }

  // Fetch remote SKILL.md to compare versions
  const gitSource = new GitSourceResolver();
  let hasUpdate = false;
  let remoteHash: string | undefined;

  try {
    const files = await gitSource.resolve(skill.importUrl, {
      branch: skill.importBranch ?? undefined,
      subDir: skill.importSubDir ?? undefined,
    });

    // Find SKILL.md and compute content hash
    const skillMd = files.find(f => f.path === "SKILL.md");
    if (skillMd) {
      const { computeContentHash } = await import("../../utils/manifest.js");
      remoteHash = computeContentHash(files);
      hasUpdate = remoteHash !== skill.contentHash;
    }
  } catch (err) {
    warn(`Failed to fetch remote: ${(err as Error).message}`);
  }

  const result: SyncCheckResult = {
    slug,
    currentVersion: skill.version,
    hasUpdate,
    remoteHash,
    localHash: skill.contentHash,
    importUrl: skill.importUrl,
    importBranch: skill.importBranch,
    importSubDir: skill.importSubDir,
    importedAt: skill.importedAt,
  };

  renderSyncCheck(result);
  closeDatabase();
}

export async function syncCheckAllAction(opts: { serverUrl?: string } = {}): Promise<void> {
  requireAuth();
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const results = await apiCall<SyncCheckResult[]>(
      serverUrl, "GET", "/api/admin/skills/sync/check-all", { credentials: (await import("./auth-cmd.js")).readCredentials()! },
    );
    renderSyncCheckAll(results);
    return;
  }

  // Local mode
  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  const skillRepo = new SkillRepository(db);

  const allSkills = await skillRepo.findAll();
  const gitSkills = allSkills.filter(s => s.importSource === "git" && s.importUrl);

  if (gitSkills.length === 0) {
    warn("No remote skills found (all skills were imported locally)");
    closeDatabase();
    return;
  }

  console.log(section("sync check all", gitSkills.length));
  console.log();
  console.log(`  Checking ${gitSkills.length} remote skill(s)...\n`);

  const results: SyncCheckResult[] = [];
  const gitSource = new GitSourceResolver();

  for (const skill of gitSkills) {
    let hasUpdate = false;
    let remoteHash: string | undefined;

    try {
      const files = await gitSource.resolve(skill.importUrl!, {
        branch: skill.importBranch ?? undefined,
        subDir: skill.importSubDir ?? undefined,
      });

      const { computeContentHash } = await import("../../utils/manifest.js");
      remoteHash = computeContentHash(files);
      hasUpdate = remoteHash !== skill.contentHash;
    } catch {
      // Fetch failed — skip this skill
    }

    results.push({
      slug: skill.slug,
      currentVersion: skill.version,
      hasUpdate,
      remoteHash,
      localHash: skill.contentHash,
      importUrl: skill.importUrl,
      importBranch: skill.importBranch,
      importSubDir: skill.importSubDir,
      importedAt: skill.importedAt,
    });
  }

  renderSyncCheckAll(results);
  closeDatabase();
}

function renderSyncCheckAll(results: SyncCheckResult[]): void {
  const updates = results.filter(r => r.hasUpdate);
  const upToDate = results.filter(r => !r.hasUpdate);

  console.log(section("sync results", results.length));
  console.log();

  if (updates.length > 0) {
    console.log(`  ${c.green("✓")} ${c.bold(`${updates.length} update(s) available:`)}`);
    console.log();
    for (const r of updates) {
      console.log(`    ${c.boldCyan(r.slug)}  ${c.dim(`v${r.currentVersion}`)} → ${c.green("update available")}`);
    }
    console.log();
    console.log(`  Run ${c.cyan("skill-mcp sync pull <slug>")} to update each skill`);
  }

  if (upToDate.length > 0) {
    if (updates.length > 0) console.log();
    console.log(`  ${c.dim("✓")} ${c.dim(`${upToDate.length} skill(s) already up to date`)}`);
  }

  console.log();
}

function renderSyncCheck(result: SyncCheckResult): void {
  console.log(section("sync check", undefined));
  console.log();
  console.log(kv("slug", c.boldCyan(result.slug)));
  console.log(kv("version", `v${result.currentVersion}`));
  console.log(kv("source", result.importUrl ?? c.dim("(local)")));
  if (result.importBranch) console.log(kv("branch", result.importBranch));
  if (result.importSubDir) console.log(kv("sub-dir", result.importSubDir));
  if (result.importedAt) console.log(kv("imported", fmtDate(result.importedAt)));
  console.log();

  if (result.hasUpdate) {
    console.log(`  ${c.green("✓")}  ${c.bold("Update available")}`);
    console.log();
    console.log(kv("local hash", result.localHash ? result.localHash.slice(0, 16) + "…" : c.dim("N/A")));
    console.log(kv("remote hash", result.remoteHash ? result.remoteHash.slice(0, 16) + "…" : c.dim("N/A")));
    console.log();
    console.log(`  Run ${c.cyan(`skill-mcp sync pull ${result.slug}`)} to update`);
  } else {
    console.log(`  ${c.dim("✓")}  ${c.dim("Already up to date")}`);
  }
  console.log();
}

export async function syncPullAction(slug: string, opts: { serverUrl?: string } = {}): Promise<void> {
  requireAuth();
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const creds = (await import("./auth-cmd.js")).readCredentials()!;
    const result = await apiCall<{ slug: string; version: string; action: string }>(
      serverUrl, "POST", `/api/admin/skills/${slug}/sync/pull`, { credentials: creds },
    );
    ok(`Synced ${c.boldCyan(result.slug)} to v${result.version}`);
    return;
  }

  // Local mode
  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  const skillRepo = new SkillRepository(db);

  const skill = await skillRepo.findBySlug(slug);
  if (!skill) {
    fail(`Skill not found: ${slug}`, "Use `skill-mcp list` to see available skills");
    closeDatabase();
    process.exit(1);
  }

  if (!skill.importUrl) {
    fail(`Skill "${slug}" has no import source (was imported locally)`);
    closeDatabase();
    process.exit(1);
  }

  // Re-import from the stored source
  const { SkillImporter } = await import("../../import/importer.js");
  const { SkillFileRepository } = await import("../../db/repositories/skill-file.repository.js");
  const { SkillVersionRepository } = await import("../../db/repositories/skill-version.repository.js");
  const { SkillEvalRepository } = await import("../../db/repositories/skill-eval.repository.js");
  const { CompositeCacheProvider } = await import("../../cache/composite.provider.js");
  const { LocalFileSystemProvider } = await import("../../storage/local-fs.provider.js");
  const { DomainEventBus } = await import("../../events/event-bus.js");
  const { CacheEpochManager } = await import("../../cache/cache-epochs.js");
  const { setupCacheSubscribers } = await import("../../events/cache-subscriber.js");
  const { createLogger } = await import("../../utils/logger.js");

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

  const importer = new SkillImporter(
    storage, skillRepo, skillFileRepo, cache, logger, eventBus,
    versionRepo, undefined, evalRepo, config.security.enableInjectionScan,
  );

  try {
    const result = await importer.import(skill.importUrl, {
      branch: skill.importBranch ?? undefined,
      subDir: skill.importSubDir ?? undefined,
      overwrite: true,
    });

    const verb = result.action === "created" ? "Synced" : "Updated";
    ok(`${verb} ${c.boldCyan(result.slug)} to v${result.version}`, [
      { key: "source", value: skill.importUrl },
      ...(skill.importBranch ? [{ key: "branch", value: skill.importBranch }] : []),
    ]);
  } catch (err) {
    fail(`Sync failed: ${(err as Error).message}`);
    process.exit(1);
  }

  closeDatabase();
}
