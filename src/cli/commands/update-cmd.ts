import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { CompositeCacheProvider } from "../../cache/composite.provider.js";
import { c, ok, fail, warn } from "../ui.js";
import { requireAuth } from "./auth-cmd.js";
import { getServerUrl, apiCall } from "../remote-client.js";

export async function updateAction(
  slug: string,
  options: {
    category?: string;
    tags?: string[];
    description?: string;
    displayName?: string;
    serverUrl?: string;
  },
): Promise<void> {
  const serverUrl = getServerUrl(options);

  if (serverUrl) {
    const creds = requireAuth();
    const body: Record<string, unknown> = {};
    if (options.category !== undefined) body.category = options.category;
    if (options.tags !== undefined) body.tags = options.tags;
    if (options.description !== undefined) body.description = options.description;
    if (options.displayName !== undefined) body.displayName = options.displayName;
    if (Object.keys(body).length === 0) { warn("No updates specified."); return; }
    await apiCall(serverUrl, "PUT", `/api/admin/skills/${slug}`, { body, credentials: creds });
    ok(`${c.bold("Updated")}  ${c.boldCyan(slug)}`);
    return;
  }

  // Local mode
  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);

  const skill = await repo.findBySlug(slug);
  if (!skill) {
    fail(`Skill not found: ${slug}`, "Use `skill-mcp list` to see available skills");
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

  ok(`${c.bold("Updated")}  ${c.boldCyan(slug)}`, [
    ...(options.category ? [{ key: "category", value: options.category }] : []),
    ...(options.tags ? [{ key: "tags", value: options.tags.join(", ") }] : []),
    ...(options.description ? [{ key: "description", value: c.dim(options.description.slice(0, 50) + (options.description.length > 50 ? "…" : "")) }] : []),
    ...(options.displayName ? [{ key: "display", value: options.displayName }] : []),
  ]);
}
