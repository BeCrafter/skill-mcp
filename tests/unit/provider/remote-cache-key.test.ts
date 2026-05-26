import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RemoteSkillProvider } from "@/provider/remote.provider.js";
import type { ICacheProvider } from "@/cache/provider.interface.js";

function memoryCache(): { cache: ICacheProvider; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const cache = {
    get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key: string, value: unknown) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    clear: async () => { store.clear(); },
    clearByPrefix: async (prefix: string) => {
      for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
    },
  } as unknown as ICacheProvider;
  return { cache, store };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("RemoteSkillProvider getSkillFiles cache key collision (T-729)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does NOT collide between paths=['a,b.md'] and paths=['a','b.md']", async () => {
    const { cache, store } = memoryCache();
    const provider = new RemoteSkillProvider("http://cloud", "token", cache);

    // First call returns one synthetic file for the comma-in-name path.
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return jsonResponse({
        success: true,
        data: [
          { path: `result-${calls}`, content: `payload-${calls}`, encoding: "utf-8", mimeType: "text/plain" },
        ],
      });
    }) as never;

    const a = await provider.getSkillFiles("demo", ["a,b.md"]);
    const b = await provider.getSkillFiles("demo", ["a", "b.md"]);

    // Two distinct upstream calls — caches must not collapse.
    expect(calls).toBe(2);
    expect(a[0].path).toBe("result-1");
    expect(b[0].path).toBe("result-2");

    const keys = [...store.keys()].filter((k) => k.startsWith("skill:files:demo:"));
    expect(new Set(keys).size).toBe(2);
  });
});
