import { createInterface } from "node:readline/promises";
import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { LocalFileSystemProvider } from "../../storage/local-fs.provider.js";
import { CompositeCacheProvider } from "../../cache/composite.provider.js";
import { c, kv, fail, warn, section, kvWidth } from "../ui.js";

export async function removeAction(slug: string, options: { force?: boolean }): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);

  const skill = await repo.findBySlug(slug);
  if (!skill) {
    fail(`Skill not found: ${slug}`, "Use `skill-mcp list` to see available skills");
    process.exit(1);
  }

  if (!options.force) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\n  Remove ${c.boldCyan(slug)} (v${skill.version})? [y/N] `);
    rl.close();
    if (answer.toLowerCase() !== "y") {
      warn("Cancelled.");
      return;
    }
  }

  await repo.delete(slug);

  if (config.storage.type === "local-fs") {
    const storage = new LocalFileSystemProvider(config.storage.basePath);
    await storage.deleteDir(skill.storagePath);
  }

  const cache = new CompositeCacheProvider({ memory: config.cache.memory, file: config.cache.file });
  await cache.clearByPrefix(`skill:entry:${slug}`);
  await cache.clearByPrefix(`skill:file:${slug}`);

  console.log(section("removed", undefined, kvWidth(12, slug, "v" + skill.version, skill.storagePath)));
  console.log();
  console.log(kv("slug", c.boldCyan(slug)));
  console.log(kv("version", c.dim("v" + skill.version)));
  console.log(kv("storage", skill.storagePath));
  console.log();
}
