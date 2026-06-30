import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { c, badge, truncate, table, section, warn } from "../ui.js";
import { requireAuth } from "./auth-cmd.js";
import { getServerUrl, apiCall } from "../remote-client.js";

type SkillRow = { id: string; slug: string; name: string; version: string; status: string; description: string; category: string | null; tags: string[]; importSource?: string | null };

export async function listAction(options: { name?: string; tags?: string; serverUrl?: string }): Promise<void> {
  const serverUrl = getServerUrl(options);

  if (serverUrl) {
    const creds = requireAuth();
    let path = "/api/admin/skills";
    const queryParams: string[] = [];
    if (options.tags) queryParams.push(`tags=${encodeURIComponent(options.tags)}`);
    if (options.name) path = `/api/admin/skills/name/${encodeURIComponent(options.name)}`;
    else if (queryParams.length) path += "?" + queryParams.join("&");

    const skills = await apiCall<SkillRow[]>(serverUrl, "GET", path, { credentials: creds });
    if (!skills.length) { warn("No skills found."); return; }
    renderSkillTable(skills);
    return;
  }

  // Local mode
  const config = getConfig();
  runMigrations(config.database.path);
  const db = getDatabase(config.database.path);
  const repo = new SkillRepository(db);

  const skills = options.name
    ? await repo.findByName(options.name)
    : await repo.findAll(options.tags ? { tags: options.tags.split(",") } : undefined);

  if (skills.length === 0) {
    warn("No skills found.");
    return;
  }

  renderSkillTable(skills as SkillRow[]);
}

function renderSkillTable(skills: SkillRow[]): void {
  console.log(section("Skills", skills.length));
  console.log();

  const tableRows: Array<Record<string, unknown>> = [];
  const slugWidth = Math.min(Math.max(...skills.map(s => s.slug.length), 16), 36);

  for (const s of skills) {
    const meta: string[] = [];
    if (s.description) meta.push(truncate(s.description, 48));
    if (s.category) meta.push(`category: ${s.category}`);
    const metaText = meta.length ? c.dim(truncate(meta.join("  ·  "), 48)) : "";

    const tagsText = Array.isArray(s.tags) && s.tags.length
      ? c.dim(s.tags.join(", "))
      : "";

    const sourceIcon = s.importSource === "git" ? c.cyan("⬇") : c.dim("📁");

    tableRows.push({
      slug: c.boldCyan(s.slug),
      version: c.dim("v" + s.version),
      status: badge(s.status),
      source: sourceIcon,
      tags: tagsText,
      details: metaText,
    });
  }

  console.log(table(tableRows, [
    { key: "slug", header: "SLUG", width: slugWidth },
    { key: "version", header: "VERSION", width: 10 },
    { key: "status", header: "STATUS", width: 16 },
    { key: "source", header: " ", width: 3 },
    { key: "tags", header: "TAGS", width: 24 },
    { key: "details", header: "DETAILS", width: 48 },
  ]));

  console.log();
}
