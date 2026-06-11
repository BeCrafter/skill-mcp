import { describe, it, expect, vi } from "vitest";
import { SkillService } from "@/services/skill.service.js";
import type { ISkillProvider } from "@/provider/interface.js";
import type { ICacheProvider } from "@/cache/provider.interface.js";
import type { Logger } from "pino";
import type { SkillMeta, RequestContext } from "@/types/index.js";

const internalSkill: SkillMeta = {
  id: "1",
  slug: "demo",
  name: "demo",
  displayName: null,
  description: "x",
  version: "0.0.1",
  category: null,
  tags: [],
  attributes: {},
  status: "published",
  visibility: "public",
  entryFile: "SKILL.md",
  storagePath: "skills/demo/",
  contentHash: "h-deadbeef",
  createdAt: 1,
  updatedAt: 1,
};

function makeCache(): ICacheProvider {
  return {
    get: vi.fn(async () => null),
    getWithMeta: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    has: vi.fn(async () => false),
    delete: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    clearByPrefix: vi.fn(async () => {}),
  };
}

function makeProvider(skills: SkillMeta[], single: SkillMeta | null = skills[0] ?? null): ISkillProvider {
  return {
    listSkills: vi.fn(async () => skills),
    getSkillMeta: vi.fn(async () => single),
    getSkillMetaById: vi.fn(async () => null),
    getSkillEntry: vi.fn(async () => ""),
    getSkillFiles: vi.fn(async () => []),
    getSkillFileTree: vi.fn(async () => []),
    skillExists: vi.fn(async () => true),
  };
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() } as unknown as Logger;
}

const ctx: RequestContext = { tenantId: "default", userId: "alice", sessionId: "s", tags: new Set(), isAuthenticated: true };

describe("SkillService public DTO (T-302)", () => {
  it("listAccessibleSkills returns objects without storagePath / contentHash", async () => {
    const svc = new SkillService(makeProvider([internalSkill]), makeCache(), makeLogger());
    const list = await svc.listAccessibleSkills(ctx);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("storagePath");
    expect(list[0]).not.toHaveProperty("contentHash");
    expect(JSON.stringify(list)).not.toContain("storagePath");
    expect(JSON.stringify(list)).not.toContain("h-deadbeef");
  });

  it("getAccessibleSkillMeta returns a public DTO", async () => {
    const svc = new SkillService(makeProvider([internalSkill], internalSkill), makeCache(), makeLogger());
    const meta = await svc.getAccessibleSkillMeta("demo", ctx);
    expect(meta).not.toHaveProperty("storagePath");
    expect(meta).not.toHaveProperty("contentHash");
    expect(meta.slug).toBe("demo");
    expect(meta.id).toBe("1");
  });

  it("cache stores the public DTO (subsequent reads do not leak)", async () => {
    const cache = makeCache();
    const setSpy = cache.set as unknown as ReturnType<typeof vi.fn>;
    const svc = new SkillService(makeProvider([internalSkill]), cache, makeLogger());
    await svc.listAccessibleSkills(ctx);
    expect(setSpy).toHaveBeenCalled();
    const cached = setSpy.mock.calls[0][1] as Record<string, unknown>[];
    expect(cached[0]).not.toHaveProperty("storagePath");
    expect(cached[0]).not.toHaveProperty("contentHash");
  });
});
