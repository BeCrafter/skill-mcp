import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { SkillVersionRepository } from "../../db/repositories/skill-version.repository.js";
import { c, kv, warn, fail, fmtDate, table, section } from "../ui.js";
import { requireAuth, readCredentials } from "./auth-cmd.js";
import { getServerUrl, apiCall } from "../remote-client.js";

interface VersionInfo {
  version: string; contentHash: string; fileCount: number;
  storagePath: string; createdAt: number; changeSummary?: string | null;
}

export async function versionsAction(slug: string, options: { show?: string; serverUrl?: string }): Promise<void> {
  const serverUrl = getServerUrl(options);

  if (serverUrl) {
    const creds = requireAuth();
    try {
      const versions = await apiCall<VersionInfo[]>(
        serverUrl, "GET", `/api/admin/skills/${slug}/versions`, { credentials: creds },
      );

      if (options.show) {
        const v = versions.find(ver => ver.version === options.show);
        if (!v) {
          fail(`Version ${options.show} not found`, `Use "skill-mcp versions ${slug}" to see available versions`);
          process.exit(1);
        }
        console.log(section(`${slug} v${v.version}`));
        console.log();
        console.log(kv("hash", v.contentHash.slice(0, 16) + "…"));
        console.log(kv("files", String(v.fileCount)));
        console.log(kv("storage", v.storagePath));
        console.log(kv("created", fmtDate(v.createdAt)));
        if (v.changeSummary) console.log(kv("summary", v.changeSummary));
        console.log();
        return;
      }

      if (!versions.length) { warn(`No version history for "${slug}"`); return; }

      console.log(section("Version history", versions.length));
      console.log();
      const rows = versions.map(v => ({
        version: v.version,
        hash: c.dim(v.contentHash.slice(7, 15)),
        files: c.dim(String(v.fileCount)),
        created: c.dim(fmtDate(v.createdAt)),
      }));
      console.log(table(rows, [
        { key: "version", header: "VERSION", width: 12 },
        { key: "hash", header: "HASH", width: 10 },
        { key: "files", header: "FILES", width: 6, align: "right" },
        { key: "created", header: "CREATED", width: 18 },
      ]));
      console.log();
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
    if (!skill) {
      fail(`Skill not found: ${slug}`, "Use `skill-mcp list` to see available skills");
      process.exit(1);
    }

    const versions = versionRepo.findBySkillId(skill.id);

    if (options.show) {
      const v = versionRepo.findByVersion(skill.id, options.show);
      if (!v) {
        fail(`Version ${options.show} not found`, `Use "skill-mcp versions ${slug}" to see available versions`);
        process.exit(1);
      }
      console.log(section(`${slug} v${v.version}`));
      console.log();
      console.log(kv("hash", v.contentHash.slice(0, 16) + "…"));
      console.log(kv("files", String(v.fileCount)));
      console.log(kv("storage", v.storagePath));
      console.log(kv("created", fmtDate(v.createdAt)));
      if (v.changeSummary) console.log(kv("summary", v.changeSummary));
      console.log();
      return;
    }

    if (versions.length === 0) {
      warn(`No version history for "${slug}"`);
      return;
    }

    console.log(section("Version history", versions.length));
    console.log();

    const rows = versions.map(v => ({
      version: v.version + (v.version === skill.version ? " ●" : ""),
      hash: v.contentHash.slice(7, 15),
      files: String(v.fileCount),
      created: fmtDate(v.createdAt),
      current: v.version === skill.version,
    }));

    console.log(table(rows.map(r => ({
      ...r,
      version: r.current ? c.bold(r.version) : r.version,
      hash: c.dim(r.hash),
      files: c.dim(r.files),
      created: c.dim(r.created),
    })), [
      { key: "version", header: "VERSION", width: 12 },
      { key: "hash", header: "HASH", width: 10 },
      { key: "files", header: "FILES", width: 6, align: "right" },
      { key: "created", header: "CREATED", width: 18 },
    ]));

    console.log(`\n  ${c.dim("● current version")}\n`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      fail(error.message);
      process.exit(1);
    }
    throw error;
  }
}
