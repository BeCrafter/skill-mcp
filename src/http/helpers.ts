import type { IncomingMessage, ServerResponse } from "node:http";
import { URL as URLParser } from "node:url";
import { BadRequestError } from "../utils/errors.js";
import type { HttpContext } from "./context.js";

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

export function readBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      received += chunk.length;
      if (received > maxBytes) {
        aborted = true;
        req.destroy();
        reject(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!aborted) reject(err);
    });
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

/**
 * Read the request body and JSON-parse it, throwing `BadRequestError` on
 * malformed JSON. Pair with the `errorMap` middleware to surface a 400.
 */
export async function readJsonBody<T = unknown>(req: IncomingMessage, maxBytes?: number): Promise<T> {
  const buf = await readBody(req, maxBytes);
  try {
    return JSON.parse(buf.toString()) as T;
  } catch {
    throw new BadRequestError("Invalid JSON in request body");
  }
}

/**
 * Pull a path param and validate it is a syntactically safe slug (no path
 * traversal, no separators). Throws `BadRequestError` otherwise — the caller
 * does not need to write a 400 itself; the `errorMap` middleware does so.
 *
 * Use `requireSlug(ctx)` for the conventional `:slug` param, or pass a
 * custom name (e.g. `requireSlug(ctx, "identifier")`).
 */
/**
 * Validate a `paths: string[]` body for the /skills/:slug/files endpoints.
 * Caps length and requires every element to be a string, so non-string
 * elements never reach `validateFilePath` (which would throw a TypeError
 * → 500) and oversized arrays cannot fan out into thousands of parallel
 * storage gets even at the cost of `pMap` concurrency budget.
 */
const MAX_FILE_PATHS_PER_REQUEST = 100;

export function requireFilePaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new BadRequestError("paths must be an array");
  }
  if (value.length === 0) {
    throw new BadRequestError("paths must not be empty");
  }
  if (value.length > MAX_FILE_PATHS_PER_REQUEST) {
    throw new BadRequestError(`paths exceeds max length of ${MAX_FILE_PATHS_PER_REQUEST}`);
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new BadRequestError("paths must contain only strings");
    }
  }
  return value as string[];
}

export function requireSlug(ctx: HttpContext, paramName = "slug"): string {
  const value = ctx.params[paramName];
  if (!value || !isValidSlug(value)) {
    throw new BadRequestError(`Invalid ${paramName === "slug" ? "skill slug" : paramName}`);
  }
  return value;
}
