import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RemoteSkillProvider, parseRetryAfter } from "../../../src/provider/remote.provider.js";
import { UpstreamError, SkillNotFoundError } from "../../../src/utils/errors.js";
import type { ICacheProvider } from "../../../src/cache/provider.interface.js";

function memoryCache(): ICacheProvider {
  const store = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    clear: async () => {
      store.clear();
    },
    clearByPrefix: async (prefix: string) => {
      for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
    },
  } as ICacheProvider;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

const validSkillMeta = {
  id: "00000000-0000-0000-0000-000000000001",
  slug: "demo",
  name: "demo",
  displayName: null,
  description: "",
  version: "1.0.0",
  category: null,
  tags: [],
  attributes: {},
  status: "published",
  visibility: "private",
  entryFile: "SKILL.md",
  storagePath: "demo/",
  contentHash: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("parseRetryAfter", () => {
  it("returns null when header missing or empty", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("   ")).toBeNull();
  });

  it("parses delta-seconds", () => {
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("120")).toBe(120_000);
  });

  it("parses HTTP-date relative to now", () => {
    const now = 1_700_000_000_000;
    const future = new Date(now + 10_000).toUTCString();
    expect(parseRetryAfter(future, now)).toBe(10_000);
  });

  it("returns null on garbage", () => {
    expect(parseRetryAfter("not-a-number-or-date")).toBeNull();
  });
});

describe("RemoteSkillProvider retry policy (T-205)", () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  let provider: RemoteSkillProvider;

  beforeEach(() => {
    provider = new RemoteSkillProvider("http://cloud.test", "tok", memoryCache());
    // Speed up backoff so tests don't sleep seconds.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).retryBaseDelay = 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).retryMaxDelay = 10;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("retries 503 then succeeds on 200", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("upstream busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("upstream busy", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [validSkillMeta] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const skills = await provider.listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].slug).toBe("demo");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry on 404 (fail-fast 4xx)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("not found", { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.getSkillMeta("missing");
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 400 (fail-fast 4xx) — surfaces UpstreamError", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("bad", { status: 400 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(provider.listSkills()).rejects.toBeInstanceOf(UpstreamError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 500 once, then fails fast on second 500", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("oops", { status: 500 }))
      .mockResolvedValueOnce(new Response("oops", { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(provider.listSkills()).rejects.toBeInstanceOf(UpstreamError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After delta-seconds on 429", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limit", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const before = Date.now();
    await provider.listSkills();
    const elapsed = Date.now() - before;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // retry-after: 0 + tiny base delay → completes within 200ms
    expect(elapsed).toBeLessThan(500);
  });

  it("translates SkillNotFoundError on 404 entry endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("not found", { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(provider.getSkillEntry("ghost")).rejects.toBeInstanceOf(SkillNotFoundError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries network failures (TypeError) up to maxRetries then throws UpstreamError", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await provider.listSkills().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    // maxRetries=3 → 4 attempts total
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("exhausts retries on persistent 503 and throws UpstreamError carrying status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("busy", { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await provider.listSkills().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).upstreamStatus).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 + 3 retries
  });
});
