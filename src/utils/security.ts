// Patterns are tagged so callers (and metrics) can group similar attempts.
// Each entry name is stable — exposed as the `pattern` label on the
// mcp_injection_alert counter — so don't rename without coordinating dashboards.
const INJECTION_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "ignore_previous", pattern: /ignore\s+(previous|above|all|prior)\s+(instructions?|prompts?|context|messages?)/i },
  { name: "forget_context", pattern: /forget\s+(everything|all|previous|prior|the\s+above)/i },
  { name: "role_override", pattern: /you\s+are\s+now\s+(a|an|the|free|no\s+longer)/i },
  { name: "developer_mode", pattern: /(developer|dev|jailbreak|do\s+anything\s+now|dan)\s+mode/i },
  { name: "system_role_inject", pattern: /(^|\n)\s*(system|assistant|user)\s*:\s*$/im },
  { name: "im_start_marker", pattern: /<\|\s*im_start\s*\|>|<\|\s*im_end\s*\|>/i },
  { name: "policy_override", pattern: /override\s+(your|the|all|safety|security|previous)\s+(rules?|policies|instructions?|guidelines?)/i },
  { name: "exfiltrate_instructions", pattern: /(reveal|print|show|expose|leak|repeat)\s+(your|the)\s+(system\s+)?(prompt|instructions?|rules?)/i },
  { name: "html_comment_marker", pattern: /<!--\s*(prompt|injection|system)\s*:/i },
  { name: "data_uri_script", pattern: /data:\s*text\/(html|javascript)/i },
];

export interface ScanIssue {
  name: string;
  description: string;
}

export interface ScanResult {
  safe: boolean;
  issues: string[];
  matches: ScanIssue[];
}

export function scanForInjection(content: string): ScanResult {
  const issues: string[] = [];
  const matches: ScanIssue[] = [];
  for (const { name, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      const description = `Suspicious pattern detected: ${name}`;
      issues.push(description);
      matches.push({ name, description });
    }
  }
  return { safe: matches.length === 0, issues, matches };
}

/**
 * Validate a file path to prevent directory traversal.
 *
 * Splits on `/` and checks segments — a substring `..` check (the previous
 * implementation) would falsely reject legitimate filenames like
 * `foo..bar.md`. This rejects only the actual traversal segment `..` and
 * absolute paths.
 *
 * Note: storage providers should still apply `safeJoin` (see
 * `src/utils/manifest.ts`) as a second line of defence — this function is
 * for API-boundary input validation, not the canonical path-confinement check.
 */
export function validateFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");

  if (normalized.startsWith("/")) {
    throw new Error(`Absolute paths not allowed: ${filePath}`);
  }

  const segments = normalized.split("/");
  if (segments.some((seg) => seg === "..")) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }

  return normalized;
}

/** Determine if a file is text-based by its extension */
export function isTextFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const TEXT_EXTENSIONS = new Set([
    "md", "txt", "json", "yaml", "yml", "toml",
    "js", "ts", "tsx", "jsx", "mjs", "cjs",
    "py", "rb", "go", "rs", "java", "kt",
    "sh", "bash", "zsh",
    "html", "css", "scss", "less",
    "xml", "svg",
    "sql",
    "env", "ini", "cfg", "conf",
  ]);
  return TEXT_EXTENSIONS.has(ext);
}

/** Get MIME type based on file extension */
export function getMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const MIME_TYPES: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    yaml: "text/yaml",
    yml: "text/yaml",
    js: "text/javascript",
    ts: "text/typescript",
    py: "text/x-python",
    html: "text/html",
    css: "text/css",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    webm: "video/webm",
    pdf: "application/pdf",
    zip: "application/zip",
  };
  return MIME_TYPES[ext] ?? "application/octet-stream";
}
