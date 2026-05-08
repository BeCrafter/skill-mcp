import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { SkillVersionRepository } from "../../db/repositories/skill-version.repository.js";
import { c, kv, sep, warn, fail, fmtDate } from "../ui.js";

export async function versionsAction(slug: string, options: { show?: string }): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const skillRepo = new SkillRepository(db);
  const versionRepo = new SkillVersionRepository(db);

  try {
    const skill = await skillRepo.findBySlug(slug);
    if (!skill) {
      fail(`Skill not found: ${slug}`);
      process.exit(1);
    }

    const versions = versionRepo.findBySkillId(skill.id);

    if (options.show) {
      const v = versionRepo.findByVersion(skill.id, options.show);
      if (!v) {
        fail(`Version ${options.show} not found`);
        process.exit(1);
      }
      console.log(`\n  ${c.boldCyan(slug)}  ${c.dim("v" + v.version)}\n  ${sep(52)}\n`);
      console.log(kv("hash",    v.contentHash.slice(0, 16) + "…"));
      console.log(kv("files",   String(v.fileCount)));
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

    console.log(`\n  ${c.bold("Version history")}  ${c.dim("·")}  ${c.boldCyan(slug)}\n`);

    const COL = { ver: 10, hash: 10, files: 6, date: 18 };
    const header =
      `  ${c.dim("VERSION".padEnd(COL.ver))}` +
      `  ${c.dim("HASH".padEnd(COL.hash))}` +
      `  ${c.dim("FILES".padStart(COL.files))}` +
      `  ${c.dim("CREATED")}`;
    console.log(header);
    console.log(`  ${sep(COL.ver + COL.hash + COL.files + COL.date + 6)}`);

    for (const v of versions) {
      const isCurrent = v.version === skill.version;
      const verCol = (v.version + (isCurrent ? " ●" : "  ")).padEnd(COL.ver);
      const hashCol = v.contentHash.slice(7, 15).padEnd(COL.hash);
      const filesCol = String(v.fileCount).padStart(COL.files);
      const dateCol = fmtDate(v.createdAt);
      const row = `  ${verCol}  ${hashCol}  ${filesCol}  ${dateCol}`;
      console.log(isCurrent ? c.bold(row) : row);
    }

    console.log(`\n  ${c.dim("● current version")}\n`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      fail(error.message);
      process.exit(1);
    }
    throw error;
  }
}
