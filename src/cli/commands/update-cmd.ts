import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { CompositeCacheProvider } from "../../cache/composite.provider.js";
import { c, ok, fail, warn } from "../ui.js";

export async function updateAction(
  slug: string,
  options: {
    category?: string;
    tags?: string[];
    description?: string;
    displayName?: string;
  },
): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);

  const skill = await repo.findBySlug(slug);
  if (!skill) {
    fail(`Skill not found: ${slug}`);
    process.exit(1);
  }

  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (options.category    !== undefined) updates.category    = options.category;
  if (options.tags        !== undefined) updates.tags        = options.tags;
  if (options.description !== undefined) updates.description = options.description;
  if (options.displayName !== undefined) updates.displayName = options.displayName;

  if (Object.keys(updates).length <= 1) {
    warn("No updates specified.");
    return;
  }

  await repo.update(skill.id, updates);

  const cache = new CompositeCacheProvider({ memory: config.cache.memory, file: config.cache.file });
  await cache.clearByPrefix(`skill:entry:${slug}`);
  await cache.clearByPrefix(`skill:file:${slug}`);

  ok(`${c.bold("Updated")}  ${c.boldCyan(slug)}`);
}
