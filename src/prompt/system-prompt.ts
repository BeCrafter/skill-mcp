import type { SkillMeta } from "../types/index.js";

export function buildSkillSystemPrompt(skills: SkillMeta[]): string {
  const indexLines = skills
    .filter(s => s.status === "published")
    .map(s => {
      const desc = (s.description ?? "").length > 80
        ? s.description.slice(0, 77) + "..."
        : s.description;
      return `    - ${s.slug}: ${desc}`;
    });

  if (indexLines.length === 0) {
    return [
      `## Cloud Skills`,
      ``,
      `No skills are currently available.`,
    ].join("\n");
  }

  return [
    `## Cloud Skills (mandatory)`,
    ``,
    `Before replying, scan the skills below. If a skill matches or is even`,
    `partially relevant to the task, you MUST load it with skill_view(skill_slug)`,
    `and follow its instructions strictly. Do NOT skip loading — skills contain`,
    `specialized workflows, API commands, and proven approaches that outperform`,
    `general methods.`,
    ``,
    `If you loaded a skill but its instructions were incomplete or wrong, continue`,
    `and note the issues. Always prefer the skill's approach over your own knowledge`,
    `for the specific domain.`,
    ``,
    `<available_skills>`,
    ...indexLines,
    `</available_skills>`,
    ``,
    `### Skill usage rules:`,
    `1. Always call skill_view(skill_slug) FIRST to load the full instructions`,
    `2. Call skill_file(skill_slug, file_paths) when the skill references other files`,
    `   (pass an array of paths to batch-load multiple files)`,
    `3. After loading a skill, follow its instructions exactly — do not substitute`,
    `   your own approach`,
  ].join("\n");
}
