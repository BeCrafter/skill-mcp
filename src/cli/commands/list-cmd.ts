import { getConfig } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { getDatabase } from "../../db/connection.js";
import { SkillRepository } from "../../db/repositories/skill.repository.js";
import { c, badge, truncate, sep, warn } from "../ui.js";

type SkillRow = { slug: string; name: string; version: string; status: string; description: string; category: string | null; tags: string[] };

function printSkillRow(s: SkillRow, slugWidth: number): void {
  const nameTag = s.name !== s.slug ? `  ${c.dim("[" + s.name + "]")}` : "";
  console.log(`  ${c.boldCyan(s.slug.padEnd(slugWidth))}  ${c.dim(("v" + s.version).padEnd(9))}  ${badge(s.status)}${nameTag}`);
  if (s.description) console.log(`  ${c.dim(truncate(s.description))}`);
  const extras: string[] = [];
  if (s.category) extras.push(`category: ${s.category}`);
  if (s.tags.length) extras.push(`tags: ${s.tags.join(", ")}`);
  if (extras.length) console.log(`  ${c.dim(extras.join("  ·  "))}`);
}

export async function listAction(options: { name?: string; tags?: string }): Promise<void> {
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

  const slugWidth = Math.min(Math.max(...skills.map(s => s.slug.length), 16), 36);

  console.log(`\n  ${c.bold(String(skills.length))} ${skills.length === 1 ? "skill" : "skills"}\n`);
  console.log(`  ${sep(slugWidth + 34)}\n`);

  for (const s of skills) {
    printSkillRow(s as SkillRow, slugWidth);
    console.log();
  }
}
