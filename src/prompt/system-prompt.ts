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
      `## 扩展技能（Extension Skills）`,
      ``,
      `当前没有可用的扩展技能。`,
    ].join("\n");
  }

  return [
    `## 扩展技能（Extension Skills，必检）`,
    ``,
    `这些是通过 MCP 提供的扩展技能，应与系统内置技能一起使用。`,
    ``,
    `在回答任何问题前，先扫描此列表。如果有技能与用户请求相关`,
    `（哪怕只是部分相关），你必须先调用 skill_view(skill_slug) 或 skill_view(skill_id) 加载该技能的`,
    `完整指令，并严格按其指令执行任务。`,
    ``,
    `宁可加载一个不需要的技能，也不要遗漏可能需要的技能。`,
    `技能包含专业的工作流、API 用法和已知陷阱，能显著优于通用方案。`,
    ``,
    `如果加载的技能指令不完整或有误，继续执行并记录问题。`,
    `在特定领域内，始终优先使用技能中的方案，而非你自己的知识。`,
    ``,
    `<available_skills>`,
    ...indexLines,
    `</available_skills>`,
    ``,
    `### 技能使用规则：`,
    `1. 先调用 skill_view(skill_slug) 或 skill_view(skill_id) 加载完整指令`,
    `   其中 skill_slug 为列表中的 slug，skill_id 为列表中的 [id:xxx]`,
    `2. 当技能引用其他文件时，调用 skill_file(skill_slug, file_paths) 或 skill_file(skill_id, file_paths) 批量加载`,
    `   （传入文件路径数组以并发读取多个文件）`,
    `3. 加载技能后，严格按照其指令执行——不要用自己的方案替代`,
  ].join("\n");
}
