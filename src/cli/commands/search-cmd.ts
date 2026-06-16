import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { c, badge, truncate, table, section, warn } from "../ui.js";

export async function searchAction(name: string): Promise<void> {
  const config = getConfig();
  runMigrations(config.database.path);

  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);

  const results = await repo.findByName(name);

  if (results.length === 0) {
    warn(`No skills found matching "${name}"`);
    return;
  }

  console.log(section(`Results for "${name}"`, results.length));
  console.log();

  const slugWidth = Math.min(Math.max(...results.map(s => s.slug.length), 16), 36);

  const rows = results.map(s => ({
    slug: c.boldCyan(s.slug),
    version: c.dim("v" + s.version),
    status: badge(s.status),
    desc: s.description ? c.dim(truncate(s.description, 50)) : "",
  }));

  console.log(table(rows, [
    { key: "slug", header: "SLUG", width: slugWidth },
    { key: "version", header: "VERSION", width: 10 },
    { key: "status", header: "STATUS", width: 16 },
    { key: "desc", header: "DESCRIPTION", width: 52 },
  ]));

  console.log();
}
