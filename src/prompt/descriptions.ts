export const SKILL_LIST_DESC = [
  "【Must-Check Resource】List all available extension skills (slug, id, and brief description).",
  "",
  "These are extension skills provided via MCP and should be used alongside built-in skills.",
  "",
  "On first conversation, call skill_list() to get the full list and learn all available tags.",
  "For subsequent requests, call skill_list({tags: [\"relevant-tag\"]}) to narrow down",
  "and get more precise matches.",
  "",
  "Examples:",
  "- User asks about code review → skill_list({tags: [\"code-review\"]})",
  "- User asks about cache issues → skill_list({tags: [\"debugging\", \"cache\"]})",
  "- Uncertain → skill_list() returns all",
  "",
  "It's better to load a skill you don't need than to miss one you might need.",
  "Skills contain specialized workflows, API usage, and known pitfalls that",
  "significantly outperform generic approaches.",
  "List format: - slug [id:uuid]: description. Use skill_view(slug) or skill_view(id) to load.",
].join("\n");

export const SKILL_VIEW_DESC = [
  "【Skill Entry】Load the full instructions (SKILL.md) for a specified skill.",
  "",
  "This is the only entry point for using any skill — you must call this tool first",
  "to get the complete instructions, then follow the steps and constraints defined",
  "in the instructions strictly. Do not skip skill_view and guess skill content.",
  "",
  "After loading, if the instructions reference other files (references/, templates/, scripts/),",
  "use skill_file to batch-load them. Only call this tool after discovering relevant skills via skill_list.",
  "Supports skill_view(skill_slug) or skill_view(skill_id).",
].join("\n");

export const SKILL_FILE_DESC = [
  "【Auxiliary Files】Batch-read auxiliary files from a skill package (reference docs, templates, scripts, images, videos, etc.).",
  "",
  "Prerequisite: Must load the skill main file via skill_view first.",
  "Only call this tool when the skill instructions (SKILL.md) explicitly reference an auxiliary file.",
  "Do not proactively browse or guess files in the skill package — only load files mentioned in the main instructions.",
  "",
  "Supports passing multiple file paths for batch concurrent reading to reduce round trips.",
  "Supports skill_file(skill_slug, file_paths) or skill_file(skill_id, file_paths).",
  "Text files return content; images/videos return as base64.",
].join("\n");

export const SKILL_FEEDBACK_DESC = [
  "【Effect Feedback】After completing a task using a skill, call this tool to report the result.",
  "This helps improve skill quality and recommendation ranking. Report honestly.",
  "",
  "Example:",
  "skill_feedback({",
  "  skill_slug: \"product-analyzer\",",
  "  outcome: \"success\",",
  "  context: \"Analyzed product cache inconsistency issue\",",
  "  agent_comment: \"Skill steps were clear, successfully identified the problem\"",
  "})",
].join("\n");
