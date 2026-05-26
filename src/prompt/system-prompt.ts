/**
 * Static system prompt returned via MCP `initialize.result.instructions`.
 *
 * Why static: instructions is a server-construction-time constant in the MCP
 * SDK, while the visible skill set is per-caller (RBAC tag filtering). Putting
 * a skill catalog here would either leak private slugs to anonymous callers
 * or freeze a stale list for a session's lifetime. Authoritative discovery
 * lives in `skill_list`, which always runs under the caller's RequestContext.
 */
export function buildSkillSystemPrompt(): string {
  return [
    `## 扩展技能（Extension Skills，必检）`,
    ``,
    `本 MCP 服务器提供一组按需加载的扩展技能。在回答任何问题前：`,
    ``,
    `1. 先调用 skill_list({}) 获取当前调用方可见的技能目录；`,
    `   - 如果已知领域标签，可用 skill_list({tags: ["tag"]}) 缩小范围。`,
    `2. 扫描列表中的 slug 与描述。如果有技能与用户请求相关`,
    `   （哪怕只是部分相关），调用 skill_view(skill_slug) 加载完整指令，`,
    `   并严格按其指令执行任务。`,
    `3. 当技能指令引用其他文件（references/、templates/、scripts/ 等）时，`,
    `   调用 skill_file(skill_slug, file_paths) 批量加载（数组并发读取）。`,
    ``,
    `宁可加载一个不需要的技能，也不要遗漏可能需要的技能。`,
    `技能包含专业的工作流、API 用法和已知陷阱，能显著优于通用方案。`,
    `在特定领域内，始终优先使用技能中的方案，而非你自己的知识。`,
    `如果加载的技能指令不完整或有误，继续执行并记录问题。`,
  ].join("\n");
}
