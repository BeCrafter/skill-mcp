/**
 * P0-6 — verify the §17.6 span list is actually emitted by the wired
 * components (not just the helper). Each test exercises a real call site and
 * asserts the expected span name and user attributes appear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trace, context } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { SkillService } from "../../../src/services/skill.service.js";
import { TagPermissionFilter } from "../../../src/permission/tag-filter.js";
import type { ISkillProvider } from "../../../src/provider/interface.js";
import type { ICacheProvider } from "../../../src/cache/provider.interface.js";
import type { Logger } from "pino";
import type { SkillMeta, RequestContext } from "../../../src/types/index.js";

const SAMPLE: SkillMeta = {
  id: "1", slug: "alpha", name: "alpha",
  displayName: null, description: "alpha skill",
  version: "0.0.1", category: null, tags: [], attributes: {},
  status: "published", visibility: "public", entryFile: "SKILL.md",
  storagePath: "alpha/", contentHash: null,
  createdAt: 1, updatedAt: 1,
};

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

function authCtx(): RequestContext {
  return {
    userId: "user-1",
    sessionId: "sess-1",
    tags: new Set(["alpha"]),
    isAuthenticated: true,
  };
}

function mockLogger(): Logger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
  } as unknown as Logger;
}

function mockCache(): ICacheProvider {
  return {
    get: vi.fn().mockResolvedValue(null),
    getWithMeta: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    delete: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    clearByPrefix: vi.fn().mockResolvedValue(undefined),
  };
}

function mockProvider(overrides: Partial<ISkillProvider> = {}): ISkillProvider {
  return {
    listSkills: vi.fn().mockResolvedValue([SAMPLE]),
    getSkillMeta: vi.fn().mockResolvedValue(SAMPLE),
    getSkillMetaById: vi.fn().mockResolvedValue(SAMPLE),
    getSkillEntry: vi.fn().mockResolvedValue("# alpha"),
    getSkillFiles: vi.fn().mockResolvedValue([]),
    getSkillFileTree: vi.fn().mockResolvedValue([]),
    skillExists: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  contextManager.disable();
  context.disable();
  trace.disable();
});

function span(name: string) {
  return exporter.getFinishedSpans().find(s => s.name === name);
}

describe("SkillService spans (§17.6)", () => {
  it("emits skill.service.listSkillsIndex with user attrs", async () => {
    const svc = new SkillService(mockProvider(), mockCache(), mockLogger());
    await svc.listSkillsIndex(authCtx());
    const s = span("skill.service.listSkillsIndex");
    expect(s).toBeDefined();
    expect(s!.attributes["skill_mcp.user_id"]).toBe("user-1");
  });

  it("emits skill.service.viewSkillEntry", async () => {
    const svc = new SkillService(mockProvider(), mockCache(), mockLogger());
    await svc.viewSkillEntry("alpha", authCtx());
    expect(span("skill.service.viewSkillEntry")).toBeDefined();
  });

  it("emits skill.service.readSkillFiles", async () => {
    const svc = new SkillService(mockProvider(), mockCache(), mockLogger());
    await svc.readSkillFiles("alpha", ["a.md"], authCtx());
    expect(span("skill.service.readSkillFiles")).toBeDefined();
  });

  it("emits skill.service.listAccessibleSkills", async () => {
    const svc = new SkillService(mockProvider(), mockCache(), mockLogger());
    await svc.listAccessibleSkills(authCtx());
    expect(span("skill.service.listAccessibleSkills")).toBeDefined();
  });
});

describe("TagPermissionFilter span (§17.6)", () => {
  it("emits perm.filter with input_count and is_admin attrs", async () => {
    const filter = new TagPermissionFilter(authCtx());
    const skills: SkillMeta[] = [SAMPLE, { ...SAMPLE, id: "2", slug: "beta" }];
    await filter.filter(skills);
    const s = span("perm.filter");
    expect(s).toBeDefined();
    expect(s!.attributes["perm.input_count"]).toBe(2);
    expect(s!.attributes["perm.is_admin"]).toBe(false);
  });
});

describe("audit.write span (§17.6)", () => {
  it("emits audit.write with action attribute", async () => {
    const { AccessLogService } = await import("../../../src/services/access-log.service.js");
    const repo = {
      create: vi.fn().mockResolvedValue(undefined),
      findRecent: vi.fn().mockResolvedValue([]),
      countByActionLast24h: vi.fn().mockResolvedValue(0),
    };
    const svc = new AccessLogService(repo as never, mockLogger());
    await svc.log({
      userId: "user-1",
      action: "skill_view",
      skillSlug: "alpha",
      success: true,
      timestamp: Date.now(),
    } as never);
    const s = span("audit.write");
    expect(s).toBeDefined();
    expect(s!.attributes["audit.action"]).toBe("skill_view");
    expect(s!.attributes["audit.skill_slug"]).toBe("alpha");
  });
});
