import type { IncomingMessage, ServerResponse } from "node:http";
import { URL as URLParser } from "node:url";

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function getSafeHost(headerHost: string | undefined): string {
  const host = headerHost ?? "localhost";
  if (!/^[a-zA-Z0-9:.-]+$/.test(host)) {
    return "localhost";
  }
  return host;
}

export function isValidSlug(slug: string): boolean {
  if (!slug || slug.length > 255) return false;
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..") || slug.includes("~")) return false;
  return /^[a-zA-Z0-9_-]+$/.test(slug);
}

export function parsePagination(query: URLSearchParams): { offset: number; limit: number } {
  const offset = Math.max(0, parseInt(query.get("offset") ?? "0", 10));
  const limit = Math.min(100, Math.max(1, parseInt(query.get("limit") ?? "50", 10)));
  return { offset, limit };
}

export function parseQuery(url: string, host: string | undefined): URLSearchParams {
  const safeHost = getSafeHost(host);
  const urlObj = new URLParser(url, `http://${safeHost}`);
  return urlObj.searchParams;
}

export function parseJsonBody(body: Buffer): unknown {
  return JSON.parse(body.toString());
}
