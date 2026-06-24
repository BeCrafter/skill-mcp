import type { Credentials } from "./commands/auth-cmd.js";

/**
 * Determine the server URL for remote mode.
 * Priority: CLI --server-url > SKILL_MCP_SERVER_URL env var > null (local mode)
 */
export function getServerUrl(opts: { serverUrl?: string } = {}): string | null {
  const url = opts.serverUrl || process.env.SKILL_MCP_SERVER_URL;
  return url ? url.replace(/\/$/, "") : null;
}

/**
 * Make an authenticated HTTP API call to the server.
 */
export async function apiCall<T>(
  serverUrl: string,
  method: string,
  path: string,
  opts: { body?: unknown; credentials?: Credentials } = {},
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.credentials) {
    headers["Authorization"] = `Bearer ${opts.credentials.accessToken}`;
  }

  const fetchOpts: RequestInit = { method, headers };
  if (opts.body) fetchOpts.body = JSON.stringify(opts.body);

  const res = await fetch(`${serverUrl}${path}`, fetchOpts);

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(errorBody.error || `API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as { data?: T; success?: boolean };
  return (json.data ?? json) as T;
}

/**
 * Upload a file to the server via multipart/form-data.
 */
export async function uploadFile<T>(
  serverUrl: string,
  path: string,
  fileBuffer: Buffer,
  metadata: Record<string, unknown>,
  credentials: Credentials,
): Promise<T> {
  const boundary = `----SkillMCP${Date.now()}`;
  const parts: Buffer[] = [];

  // File part
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill-package.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`,
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from("\r\n"));

  // Metadata part
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n`,
  ));
  parts.push(Buffer.from(JSON.stringify(metadata)));
  parts.push(Buffer.from("\r\n"));

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const res = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Authorization": `Bearer ${credentials.accessToken}`,
    },
    body,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(errorBody.error || `Upload failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as { data?: T; success?: boolean };
  return (json.data ?? json) as T;
}
