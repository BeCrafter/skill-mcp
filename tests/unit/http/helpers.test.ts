import { describe, it, expect } from "vitest";
import {
  RequestBodyTooLargeError, readBody, json, getSafeHost, isValidSlug,
  parsePagination, parseQuery, parseJsonBody, readJsonBody, requireFilePaths,
  requireSlug,
} from "@/http/helpers.js";
import type { HttpContext } from "@/http/context.js";
import { Readable } from "node:stream";
import { IncomingMessage } from "node:http";

function fakeReq(chunks: (Buffer | string)[], opts: { destroy?: boolean } = {}): IncomingMessage {
  const stream = Readable.from((async function*() {
    for (const c of chunks) yield Buffer.isBuffer(c) ? c : Buffer.from(c);
  })());
  // Minimal IncomingMessage shape: just .on/.destroy mappings.
  (stream as unknown as { destroy: () => void }).destroy = () => { opts.destroy = true; };
  return stream as unknown as IncomingMessage;
}

function fakeRes() {
  let body = "";
  let statusCode = 0;
  const headers: Record<string, unknown> = {};
  return {
    writeHead(s: number, h?: Record<string, unknown>) { statusCode = s; if (h) Object.assign(headers, h); },
    end(c?: string | Buffer) { if (c) body += c.toString(); },
    setHeader() {},
    write() {},
    _: () => ({ statusCode, body, headers }),
  } as never;
}

describe("http/helpers", () => {
  describe("readBody", () => {
    it("concatenates chunks into a Buffer", async () => {
      const buf = await readBody(fakeReq(["hel", "lo"]));
      expect(buf.toString()).toBe("hello");
    });

    it("rejects with RequestBodyTooLargeError when over the cap", async () => {
      const big = Buffer.alloc(20);
      await expect(readBody(fakeReq([big, big]), 30)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    });
  });

  describe("readJsonBody", () => {
    it("parses valid JSON", async () => {
      const out = await readJsonBody<{ a: number }>(fakeReq([JSON.stringify({ a: 1 })]));
      expect(out.a).toBe(1);
    });
    it("throws BadRequestError on malformed JSON", async () => {
      await expect(readJsonBody(fakeReq(["{not-json"]))).rejects.toThrow(/Invalid JSON/);
    });
  });

  describe("json", () => {
    it("writes status, content-type, content-length", () => {
      const res = fakeRes();
      json(res, 201, { ok: true });
      const out = (res as unknown as { _: () => { statusCode: number; body: string; headers: Record<string, unknown> } })._();
      expect(out.statusCode).toBe(201);
      expect(out.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(out.body)).toEqual({ ok: true });
    });
  });

  describe("getSafeHost", () => {
    it("falls back to localhost on undefined or unsafe host", () => {
      expect(getSafeHost(undefined)).toBe("localhost");
      expect(getSafeHost("a b c")).toBe("localhost");
      expect(getSafeHost("evil$host")).toBe("localhost");
    });
    it("preserves clean hosts and ports", () => {
      expect(getSafeHost("example.com")).toBe("example.com");
      expect(getSafeHost("api.example.com:8080")).toBe("api.example.com:8080");
    });
  });

  describe("isValidSlug", () => {
    it("rejects empty / oversized / separator / traversal / tilde", () => {
      expect(isValidSlug("")).toBe(false);
      expect(isValidSlug("a".repeat(256))).toBe(false);
      expect(isValidSlug("a/b")).toBe(false);
      expect(isValidSlug("a\\b")).toBe(false);
      expect(isValidSlug("a..b")).toBe(false);
      expect(isValidSlug("~user")).toBe(false);
      expect(isValidSlug("a b")).toBe(false);
    });
    it("accepts kebab/snake-case alphanumerics", () => {
      expect(isValidSlug("good-slug_123")).toBe(true);
    });
  });

  describe("parsePagination", () => {
    it("clamps offset to ≥0 and limit to [1, 100]", () => {
      expect(parsePagination(new URLSearchParams("offset=-5&limit=999"))).toEqual({ offset: 0, limit: 100 });
      expect(parsePagination(new URLSearchParams("offset=10&limit=20"))).toEqual({ offset: 10, limit: 20 });
      expect(parsePagination(new URLSearchParams("limit=0"))).toEqual({ offset: 0, limit: 1 });
    });
    it("uses defaults on missing values", () => {
      expect(parsePagination(new URLSearchParams())).toEqual({ offset: 0, limit: 50 });
    });
    it("documents that non-numeric inputs propagate NaN through Math.max/min", () => {
      const out = parsePagination(new URLSearchParams("offset=foo&limit=bar"));
      // Math.max(0, NaN) === NaN, Math.min(100, Math.max(1, NaN)) === NaN.
      expect(Number.isNaN(out.offset)).toBe(true);
      expect(Number.isNaN(out.limit)).toBe(true);
    });
  });

  describe("parseQuery", () => {
    it("parses query string with safe host fallback", () => {
      const q = parseQuery("/x?a=1&b=2", "evil host");
      expect(q.get("a")).toBe("1");
      expect(q.get("b")).toBe("2");
    });
  });

  describe("parseJsonBody", () => {
    it("parses Buffer JSON", () => {
      expect(parseJsonBody(Buffer.from('{"k":1}'))).toEqual({ k: 1 });
    });
    it("throws on bad JSON", () => {
      expect(() => parseJsonBody(Buffer.from("nope"))).toThrow();
    });
  });

  describe("requireFilePaths", () => {
    it("rejects non-array, empty, oversized, non-string elements", () => {
      expect(() => requireFilePaths("a")).toThrow(/must be an array/);
      expect(() => requireFilePaths([])).toThrow(/must not be empty/);
      const big = Array.from({ length: 101 }, (_, i) => `f${i}.md`);
      expect(() => requireFilePaths(big)).toThrow(/exceeds max length/);
      expect(() => requireFilePaths(["a", 42])).toThrow(/only strings/);
    });
    it("returns the array as string[] on success", () => {
      expect(requireFilePaths(["a.md", "b.md"])).toEqual(["a.md", "b.md"]);
    });
  });

  describe("requireSlug", () => {
    function ctx(slug: unknown): HttpContext {
      return { params: { slug } } as unknown as HttpContext;
    }
    it("throws BadRequestError on missing or invalid slug", () => {
      expect(() => requireSlug(ctx(undefined))).toThrow(/Invalid skill slug/);
      expect(() => requireSlug(ctx("../etc/passwd"))).toThrow(/Invalid skill slug/);
    });
    it("returns valid slug", () => {
      expect(requireSlug(ctx("good-name"))).toBe("good-name");
    });
    it("custom paramName changes error message but enforces validity", () => {
      const c2: HttpContext = { params: { identifier: "bad/x" } } as unknown as HttpContext;
      expect(() => requireSlug(c2, "identifier")).toThrow(/Invalid identifier/);
    });
  });
});
