import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RemoteSkillProvider } from "@/provider/remote.provider.js";
import { UpstreamError } from "@/utils/errors.js";
import { metrics, registry } from "@/telemetry/metrics.js";
import type { ICacheProvider } from "@/cache/provider.interface.js";

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

describe("RemoteSkillProvider zod validation (T-605)", () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  let provider: RemoteSkillProvider;

  async function getCounterValue(method: string): Promise<number> {
    const all = await registry.getMetricsAsJSON();
    const m = all.find((x) => x.name === "skill_mcp_remote_validation_errors_total");
    if (!m || !("values" in m)) return 0;
    const row = (m.values as Array<{ value: number; labels: { method?: string } }>).find(
      (v) => v.labels?.method === method,
    );
    return row?.value ?? 0;
  }

  beforeEach(() => {
    provider = new RemoteSkillProvider("http://cloud", "token", memoryCache());
    metrics.remoteValidationErrors.reset();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("listSkills accepts a valid response", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: [validSkillMeta] })) as never;
    const result = await provider.listSkills();
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("demo");
  });

  it("listSkills throws UpstreamError + bumps metric on schema mismatch", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ data: [{ slug: "demo" /* missing required fields */ }] }),
    ) as never;
    const before = await getCounterValue("listSkills");
    await expect(provider.listSkills()).rejects.toBeInstanceOf(UpstreamError);
    const after = await getCounterValue("listSkills");
    expect(after).toBe(before + 1);
  });

  it("getSkillMeta throws UpstreamError when status enum value is unknown", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ data: { ...validSkillMeta, status: "🔥" } }),
    ) as never;
    await expect(provider.getSkillMeta("demo")).rejects.toBeInstanceOf(UpstreamError);
    expect(await getCounterValue("getSkillMeta")).toBe(1);
  });

  it("getSkillFiles rejects malformed file content", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ data: [{ path: "SKILL.md" /* no content/encoding */ }] }),
    ) as never;
    await expect(provider.getSkillFiles("demo", ["SKILL.md"])).rejects.toBeInstanceOf(UpstreamError);
    expect(await getCounterValue("getSkillFiles")).toBe(1);
  });
});
