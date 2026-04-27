const INJECTION_PATTERNS = [
  /ignore\s+(previous|above|all)\s+(instructions?|prompts?)/i,
  /forget\s+(everything|all|previous)/i,
  /you\s+are\s+now\s+(a|an|free)/i,
  /system\s*:\s*$/m,
];

export interface ScanResult {
  safe: boolean;
  issues: string[];
}

export function scanForInjection(content: string): ScanResult {
  const issues: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      issues.push(`Suspicious pattern detected: ${pattern.source}`);
    }
  }
  return { safe: issues.length === 0, issues };
}

/** Validate a file path to prevent directory traversal */
export function validateFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");

  if (normalized.includes("..")) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }

  if (normalized.startsWith("/")) {
    throw new Error(`Absolute paths not allowed: ${filePath}`);
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
