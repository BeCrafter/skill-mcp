import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { SkillVersionRepository } from "../../db/repositories/skill-version.repository.js";

export async function versionsAction(slug: string, options: { show?: string }): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const skillRepo = new SkillRepository(db);
  const versionRepo = new SkillVersionRepository(db);

  try {
    const skill = await skillRepo.findBySlug(slug);
    if (!skill) {
      console.error(`✗ Skill not found: ${slug}`);
      process.exit(1);
    }

    const versions = versionRepo.findBySkillId(skill.id);
    if (versions.length === 0) {
      console.log(`No version history for skill "${slug}"`);
      return;
    }

    if (options.show) {
      const version = versionRepo.findByVersion(skill.id, options.show);
      if (!version) {
        console.error(`✗ Version ${options.show} not found`);
        process.exit(1);
      }
      console.log(`\nVersion: ${version.version}`);
      console.log(`Content Hash: ${version.contentHash}`);
      console.log(`Files: ${version.fileCount}`);
      console.log(`Storage: ${version.storagePath}`);
      console.log(`Created: ${new Date(version.createdAt).toISOString()}`);
      if (version.changeSummary) console.log(`Summary: ${version.changeSummary}`);
      return;
    }

    console.log(`\nVersion history for "${slug}":\n`);
    console.log("VERSION    HASH         FILES  DATE                 SUMMARY");
    console.log("-".repeat(80));

    for (const v of versions) {
      const current = v.version === skill.version ? " *" : "  ";
      const hash = v.contentHash.slice(7, 14);
      const date = new Date(v.createdAt).toISOString().slice(0, 16).replace("T", " ");
      const summary = v.changeSummary || "-";
      console.log(`${v.version.padEnd(10)}${current} ${hash}  ${String(v.fileCount).padStart(3)}    ${date}  ${summary.slice(0, 30)}`);
    }
    console.log(`\n* = current version`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`✗ ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
