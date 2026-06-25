import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { c, badge, truncate, table, section, warn } from "../ui.js";
import { requireAuth } from "./auth-cmd.js";
import { getServerUrl, apiCall } from "../remote-client.js";

interface SkillRow { slug: string; name: string; version: string; status: string; description: string; }

export async function searchAction(name: string, opts: { serverUrl?: string } = {}): Promise<void> {
  const serverUrl = getServerUrl(opts);

  if (serverUrl) {
    const creds = requireAuth();
    const results = await apiCall<SkillRow[]>(
      serverUrl, "GET", `/api/admin/skills/name/${encodeURIComponent(name)}`, { credentials: creds },
    );
    if (!results.length) { warn(`No skills found matching "${name}"`); return; }
    renderSearchResults(name, results);
    return;
  }

  // Local mode
  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);
  const results = await repo.findByName(name);
  if (results.length === 0) {
    warn(`No skills found matching "${name}"`);
    return;
  }
  renderSearchResults(name, results as SkillRow[]);
}

function renderSearchResults(name: string, results: SkillRow[]): void {
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
