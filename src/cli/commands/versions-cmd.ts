import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { SkillVersionRepository } from "../../db/repositories/skill-version.repository.js";
import { SkillFileRepository } from "../../db/repositories/skill-file.repository.js";
import { CompositeCacheProvider } from "../../cache/composite.provider.js";
import { LocalFileSystemProvider } from "../../storage/local-fs.provider.js";
import { LocalSkillProvider } from "../../provider/local.provider.js";
import { SkillService } from "../../services/skill.service.js";
import { c, kv, warn, fail, fmtDate, table, section } from "../ui.js";
import { requireAuth } from "./auth-cmd.js";
import { getServerUrl, apiCall } from "../remote-client.js";
import type { VersionDiff } from "../../services/skill.service.js";
import { createLogger } from "../../utils/logger.js";

interface VersionInfo {
  version: string; contentHash: string; fileCount: number;
  storagePath: string; createdAt: number; changeSummary?: string | null; isCurrent?: boolean;
}

export async function versionsAction(slug: string, options: { show?: string; diff?: string; serverUrl?: string }): Promise<void> {
  const serverUrl = getServerUrl(options);

  if (serverUrl) {
    const creds = requireAuth();
    try {
      if (options.diff) {
        const [v1, v2] = options.diff.split("..");
        if (!v1 || !v2) { fail("Invalid diff format. Use: --diff v1..v2"); process.exit(1); }
        const diff = await apiCall<VersionDiff>(
          serverUrl, "GET", `/api/admin/skills/${slug}/versions/diff?v1=${encodeURIComponent(v1)}&v2=${encodeURIComponent(v2)}`, { credentials: creds },
        );
        printDiff(diff);
        return;
      }

      const versions = await apiCall<VersionInfo[]>(
        serverUrl, "GET", `/api/admin/skills/${slug}/versions`, { credentials: creds },
      );

      if (options.show) {
        const v = versions.find(ver => ver.version === options.show);
        if (!v) { fail(`Version ${options.show} not found`); process.exit(1); }
        printVersionDetail(slug, v);
        return;
      }

      if (!versions.length) { warn(`No version history for "${slug}"`); return; }
      printVersionTable(versions);
    } catch (error: unknown) {
      if (error instanceof Error) { fail(error.message); process.exit(1); }
      throw error;
    }
    return;
  }

  // Local mode
  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  const skillRepo = new SkillRepository(db);
  const versionRepo = new SkillVersionRepository(db);

  try {
    const skill = await skillRepo.findBySlug(slug);
    if (!skill) { fail(`Skill not found: ${slug}`); process.exit(1); }

    if (options.diff) {
      const [v1, v2] = options.diff.split("..");
      if (!v1 || !v2) { fail("Invalid diff format. Use: --diff v1..v2"); process.exit(1); }
      const skillFileRepo = new SkillFileRepository(db);
      const cache = new CompositeCacheProvider({ memory: config.cache.memory, file: config.cache.file });
      const basePath = config.storage.type === "local-fs" ? config.storage.basePath : "./data/skills";
      const storage = new LocalFileSystemProvider(basePath);
      const provider = new LocalSkillProvider(storage, skillRepo, skillFileRepo, cache);
      const service = new SkillService(provider, cache, createLogger("silent"), undefined, undefined, versionRepo, skillRepo, storage, undefined, skillFileRepo);
      const diff = await service.getVersionDiff(slug, v1, v2);
      printDiff(diff);
      return;
    }

    const versions = versionRepo.findBySkillId(skill.id);

    if (options.show) {
      const v = versionRepo.findByVersion(skill.id, options.show);
      if (!v) { fail(`Version ${options.show} not found`); process.exit(1); }
      printVersionDetail(slug, v);
      return;
    }

    if (versions.length === 0) { warn(`No version history for "${slug}"`); return; }
    printVersionTable(versions.map(v => ({
      version: v.version, contentHash: v.contentHash, fileCount: v.fileCount,
      storagePath: v.storagePath, createdAt: v.createdAt, changeSummary: v.changeSummary, isCurrent: v.isCurrent,
    })));
  } catch (error: unknown) {
    if (error instanceof Error) { fail(error.message); process.exit(1); }
    throw error;
  }
}

function printVersionDetail(slug: string, v: VersionInfo): void {
  console.log(section(`${slug} v${v.version}`));
  console.log();
  console.log(kv("hash", v.contentHash.slice(0, 16) + "…"));
  console.log(kv("files", String(v.fileCount)));
  console.log(kv("storage", v.storagePath));
  console.log(kv("created", fmtDate(v.createdAt)));
  if (v.changeSummary) console.log(kv("summary", v.changeSummary));
  console.log();
}

function printVersionTable(versions: VersionInfo[]): void {
  console.log(section("Version history", versions.length));
  console.log();
  const rows = versions.map(v => ({
    version: v.isCurrent ? `→ ${v.version}` : `  ${v.version}`,
    hash: v.contentHash.slice(7, 15),
    files: String(v.fileCount),
    created: fmtDate(v.createdAt),
    isCurrent: v.isCurrent ?? false,
  }));
  console.log(table(rows.map(r => ({
    ...r,
    version: r.isCurrent ? c.bold(c.green(r.version)) : c.dim(r.version),
    hash: c.dim(r.hash),
    files: c.dim(r.files),
    created: c.dim(r.created),
  })), [
    { key: "version", header: "VERSION", width: 14 },
    { key: "hash", header: "HASH", width: 10 },
    { key: "files", header: "FILES", width: 6 },
    { key: "created", header: "CREATED", width: 18 },
  ]));
  console.log();
}

function printDiff(diff: VersionDiff): void {
  console.log(section(`${diff.slug}  ${diff.from} → ${diff.to}`, diff.files.length));
  console.log();
  if (diff.files.length === 0) { warn("No differences found"); return; }
  for (const f of diff.files) {
    const icon = f.status === "added" ? c.green("+") : f.status === "removed" ? c.red("-") : c.yellow("~");
    console.log(`  ${icon}  ${f.path}`);
    if (f.diff) {
      for (const line of f.diff.split("\n")) {
        if (line.startsWith("+")) console.log(`    ${c.green(line)}`);
        else if (line.startsWith("-")) console.log(`    ${c.red(line)}`);
        else if (line.startsWith("@@")) console.log(`    ${c.cyan(line)}`);
        else console.log(`    ${c.dim(line)}`);
      }
    }
  }
  console.log();
}
