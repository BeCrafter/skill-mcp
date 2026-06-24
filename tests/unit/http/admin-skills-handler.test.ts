import { describe, it, expect, vi } from "vitest";
import { Router } from "@/http/router.js";
import { errorMap } from "@/http/middleware/error-map.js";
import { registerAdminSkillRoutes } from "@/http/handlers/admin/skills.handler.js";
import type { HttpContext } from "@/http/context.js";
import type { AppDependencies } from "@/app-dependencies.js";
import { SkillNotFoundError } from "@/utils/errors.js";
import { IllegalTransitionError } from "@/services/skill-lifecycle.js";

function makeRes() {
  let body = "";
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 0,
    writeHead: vi.fn((status: number, h?: Record<string, unknown>) => {
      res.statusCode = status;
      if (h) Object.assign(headers, h);
    }),
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn((chunk?: string | Buffer) => { if (chunk) body += chunk.toString(); }),
    _body: () => body,
    _headers: () => headers,
  };
  return res as never;
}

function makeCtx(method: string, url: string, query = new URLSearchParams(), body?: unknown, headers: Record<string, string> = {}): HttpContext {
  const req = {
    headers: { "content-type": "application/json", ...headers },
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "data" && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
      return this;
    },
  } as never;
  return {
    req, res: makeRes(),
    url, method, params: {}, query,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  };
}

function bodyOf(ctx: HttpContext) {
  const r = ctx.res as unknown as { statusCode: number; _body: () => string; _headers: () => Record<string, unknown> };
  return { statusCode: r.statusCode, body: r._body() ? safeJson(r._body()) : undefined, headers: r._headers() };
}
function safeJson(s: string) { try { return JSON.parse(s); } catch { return s; } }

const PUBLIC_DEMO = {
  id: "s1", slug: "demo", name: "demo", displayName: null, description: "",
  version: "1", category: null, tags: [] as string[], attributes: {},
  status: "published" as const, visibility: "private" as const, entryFile: "SKILL.md",
  createdAt: 1, updatedAt: 1,
};

function setup() {
  const skillService = {
    adminListSkills: vi.fn().mockResolvedValue([
      { ...PUBLIC_DEMO, id: "s1", slug: "a", name: "A" },
      { ...PUBLIC_DEMO, id: "s2", slug: "b", name: "B" },
      { ...PUBLIC_DEMO, id: "s3", slug: "c", name: "C" },
    ]),
    adminFindSkillsByName: vi.fn().mockResolvedValue([PUBLIC_DEMO]),
    adminGetSkillBySlug: vi.fn(async (slug: string) => {
      if (slug === "demo") return PUBLIC_DEMO;
      throw new SkillNotFoundError(slug);
    }),
    adminUpdateSkill: vi.fn(async (_slug: string, body: Record<string, unknown>) => ({ ...PUBLIC_DEMO, ...body })),
    adminDeleteSkill: vi.fn().mockResolvedValue(undefined),
    adminGetEntry: vi.fn().mockResolvedValue("# entry"),
    adminGetFiles: vi.fn().mockResolvedValue([{ filePath: "a.md", content: "x" }]),
    adminGetFileTree: vi.fn().mockResolvedValue([{ filePath: "a.md" }]),
    adminCountSkills: vi.fn().mockResolvedValue(42),
    adminFindAccessLogs: vi.fn().mockResolvedValue([{ id: "log1" }]),
    adminImportSkill: vi.fn().mockResolvedValue({ slug: "imported" }),
    adminRollbackToVersion: vi.fn().mockResolvedValue(undefined),
    adminTransitionLifecycle: vi.fn(async (slug: string, target: string) => ({
      id: "s1", slug, name: slug, displayName: null, description: "",
      version: "1", category: null, tags: ["x"], attributes: {},
      status: target, visibility: "private", entryFile: "SKILL.md",
      storagePath: `${slug}/`, contentHash: "h", createdAt: 1, updatedAt: 1,
    })),
    getEffectivenessRates: vi.fn().mockResolvedValue(new Map([
      ["good", { rate: 0.9, count: 50 }],
      ["middling", { rate: 0.6, count: 20 }],
      ["bad", { rate: 0.2, count: 30 }],
      ["new", { rate: 0.1, count: 3 }],
    ])),
    getVersions: vi.fn().mockResolvedValue([{ version: "1.0.0" }]),
    getNextLifecycleStates: vi.fn(async () => ({ current: "draft", next: ["published", "archived"] })),
  };
  const router = new Router();
  router.use(errorMap());
  registerAdminSkillRoutes(router, { skillService } as unknown as AppDependencies);
  return { router, skillService };
}

describe("registerAdminSkillRoutes — P0-A admin convergence", () => {
  it("GET /api/admin/skills paginates and forwards filter options to service", async () => {
    const { router, skillService } = setup();
    const ctx = makeCtx("GET", "/api/admin/skills", new URLSearchParams({ offset: "1", limit: "1", "attributes.lang": "zh" }));
    await router.dispatch(ctx);
    expect(skillService.adminListSkills).toHaveBeenCalledWith(expect.objectContaining({ attributes: { lang: "zh" } }));
    const out = bodyOf(ctx);
    expect(out.statusCode).toBe(200);
    const data = (out.body as { data: unknown[]; total: number }).data;
    expect(data).toHaveLength(1);
    expect(data[0]).not.toHaveProperty("storagePath");
    expect(data[0]).not.toHaveProperty("contentHash");
  });

  it("GET /api/admin/skills/effectiveness-report classifies by rate buckets", async () => {
    const { router } = setup();
    const ctx = makeCtx("GET", "/api/admin/skills/effectiveness-report");
    await router.dispatch(ctx);
    const out = bodyOf(ctx);
    expect(out.statusCode).toBe(200);
    const report = (out.body as { data: { report: Array<{ slug: string; recommendation: string }> } }).data.report;
    expect(report.find(r => r.slug === "good")?.recommendation).toMatch(/Performing well/);
    expect(report.find(r => r.slug === "middling")?.recommendation).toMatch(/Needs attention/);
    expect(report.find(r => r.slug === "bad")?.recommendation).toMatch(/deprecating|rewriting/);
    expect(report.find(r => r.slug === "new")?.recommendation).toMatch(/Insufficient data/);
  });

  it("GET /api/admin/skills/name/:name forwards to adminFindSkillsByName", async () => {
    const { router, skillService } = setup();
    const ctx = makeCtx("GET", "/api/admin/skills/name/demo");
    await router.dispatch(ctx);
    expect(skillService.adminFindSkillsByName).toHaveBeenCalledWith("demo");
  });

  it("GET /api/admin/skills/:slug 404 unknown slug", async () => {
    const { router } = setup();
    const ctx = makeCtx("GET", "/api/admin/skills/nope");
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(404);
  });

  it("GET /api/admin/skills/:slug 400 invalid slug", async () => {
    const { router } = setup();
    const ctx = makeCtx("GET", "/api/admin/skills/has..dotdot");
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(400);
  });

  it("PUT /api/admin/skills/:slug forwards body to adminUpdateSkill", async () => {
    const { router, skillService } = setup();
    const ctx = makeCtx("PUT", "/api/admin/skills/demo", new URLSearchParams(), { description: "updated", storagePath: "evil/" });
    await router.dispatch(ctx);
    expect(skillService.adminUpdateSkill).toHaveBeenCalledWith("demo", expect.objectContaining({ description: "updated", storagePath: "evil/" }));
    expect(bodyOf(ctx).statusCode).toBe(200);
  });

  it("DELETE /api/admin/skills/:slug delegates to adminDeleteSkill", async () => {
    const { router, skillService } = setup();
    const ctx = makeCtx("DELETE", "/api/admin/skills/demo");
    await router.dispatch(ctx);
    expect(skillService.adminDeleteSkill).toHaveBeenCalledWith("demo");
    expect(bodyOf(ctx).statusCode).toBe(200);
  });

  it("GET /api/admin/skills/:slug/entry serves text/markdown", async () => {
    const { router, skillService } = setup();
    const ctx = makeCtx("GET", "/api/admin/skills/demo/entry");
    await router.dispatch(ctx);
    const out = bodyOf(ctx);
    expect(out.statusCode).toBe(200);
    expect(String(out.headers["Content-Type"])).toMatch(/text\/markdown/);
    expect(skillService.adminGetEntry).toHaveBeenCalledWith("demo");
  });

  it("POST /api/admin/skills/:slug/files validates body via requireFilePaths", async () => {
    const { router, skillService } = setup();
    const ctx = makeCtx("POST", "/api/admin/skills/demo/files", new URLSearchParams(), { paths: ["a.md"] });
    await router.dispatch(ctx);
    expect(skillService.adminGetFiles).toHaveBeenCalledWith("demo", ["a.md"]);
  });

  it("POST /api/admin/skills/:slug/files rejects empty paths with 400", async () => {
    const { router } = setup();
    const ctx = makeCtx("POST", "/api/admin/skills/demo/files", new URLSearchParams(), { paths: [] });
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(400);
  });

  it("GET /api/admin/skills/:slug/file-tree calls adminGetFileTree", async () => {
    const { router, skillService } = setup();
    const ctx = makeCtx("GET", "/api/admin/skills/demo/file-tree");
    await router.dispatch(ctx);
    expect(skillService.adminGetFileTree).toHaveBeenCalledWith("demo");
  });

  it("POST /api/admin/skills rejects multipart with 400", async () => {
    const { router } = setup();
    const ctx = makeCtx("POST", "/api/admin/skills", new URLSearchParams(), {}, {
      "content-type": "multipart/form-data; boundary=---x",
    });
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(400);
  });

  it("POST /api/admin/skills 400 when source is missing", async () => {
    const { router } = setup();
    const ctx = makeCtx("POST", "/api/admin/skills", new URLSearchParams(), { tags: ["x"] });
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(400);
  });

  it("POST /api/admin/skills calls adminImportSkill with normalized options + defaults", async () => {
    const { router, skillService } = setup();
    const ctx = makeCtx("POST", "/api/admin/skills", new URLSearchParams(), {
      source: "/local/path", tags: ["t"], category: "ai",
    });
    await router.dispatch(ctx);
    expect(skillService.adminImportSkill).toHaveBeenCalledWith("/local/path", expect.objectContaining({
      tags: ["t"], category: "ai", versionBump: "patch", overwrite: false, allowDuplicate: false,
    }));
    expect(bodyOf(ctx).statusCode).toBe(201);
  });

  it("GET /api/admin/logs requires skill_slug param (400 otherwise)", async () => {
    const { router } = setup();
    const ctx = makeCtx("GET", "/api/admin/logs");
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(400);
  });

  it("GET /api/admin/logs caps limit at 200", async () => {
    const { router, skillService } = setup();
    const ctx = makeCtx("GET", "/api/admin/logs", new URLSearchParams({ skill_slug: "demo", limit: "9999" }));
    await router.dispatch(ctx);
    expect(skillService.adminFindAccessLogs).toHaveBeenCalledWith("demo", 200);
  });

  it("GET /api/admin/stats returns total skill count from adminCountSkills", async () => {
    const { router } = setup();
    const ctx = makeCtx("GET", "/api/admin/stats");
    await router.dispatch(ctx);
    const out = bodyOf(ctx);
    expect((out.body as { data: { totalSkills: number } }).data.totalSkills).toBe(42);
  });

  it("GET /api/admin/skills/:slug/versions forwards limit", async () => {
    const { router, skillService } = setup();
    const ctx = makeCtx("GET", "/api/admin/skills/demo/versions", new URLSearchParams({ limit: "5" }));
    await router.dispatch(ctx);
    expect(skillService.getVersions).toHaveBeenCalledWith("demo", 5);
  });

  it("POST /api/admin/skills/:slug/rollback 400 without version", async () => {
    const { router } = setup();
    const ctx = makeCtx("POST", "/api/admin/skills/demo/rollback", new URLSearchParams(), {});
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(400);
  });

  it("POST /api/admin/skills/:slug/rollback delegates to adminRollbackToVersion", async () => {
    const { router, skillService } = setup();
    const ctx = makeCtx("POST", "/api/admin/skills/demo/rollback", new URLSearchParams(), { version: "1.0.0", bump: "minor" });
    await router.dispatch(ctx);
    expect(skillService.adminRollbackToVersion).toHaveBeenCalledWith("demo", "1.0.0", "minor");
    expect(bodyOf(ctx).statusCode).toBe(200);
  });

  describe("lifecycle transitions (P0-9)", () => {
    it("POST /api/admin/skills/:slug/publish calls adminTransitionLifecycle('published')", async () => {
      const { router, skillService } = setup();
      const ctx = makeCtx("POST", "/api/admin/skills/demo/publish", new URLSearchParams(), {});
      await router.dispatch(ctx);
      expect(skillService.adminTransitionLifecycle).toHaveBeenCalledWith("demo", "published", { skipEvalGate: false });
      expect(bodyOf(ctx).statusCode).toBe(200);
    });

    it("POST /api/admin/skills/:slug/publish?force=true forwards skipEvalGate=true (P1-12 stage 3)", async () => {
      const { router, skillService } = setup();
      const ctx = makeCtx("POST", "/api/admin/skills/demo/publish", new URLSearchParams("force=true"), {});
      await router.dispatch(ctx);
      expect(skillService.adminTransitionLifecycle).toHaveBeenCalledWith("demo", "published", { skipEvalGate: true });
      expect(bodyOf(ctx).statusCode).toBe(200);
    });

    it("POST /api/admin/skills/:slug/publish?force=1 does NOT bypass (only literal 'true')", async () => {
      const { router, skillService } = setup();
      const ctx = makeCtx("POST", "/api/admin/skills/demo/publish", new URLSearchParams("force=1"), {});
      await router.dispatch(ctx);
      expect(skillService.adminTransitionLifecycle).toHaveBeenCalledWith("demo", "published", { skipEvalGate: false });
    });

    it("POST /api/admin/skills/:slug/deprecate calls adminTransitionLifecycle('deprecated')", async () => {
      const { router, skillService } = setup();
      const ctx = makeCtx("POST", "/api/admin/skills/demo/deprecate", new URLSearchParams(), {});
      await router.dispatch(ctx);
      expect(skillService.adminTransitionLifecycle).toHaveBeenCalledWith("demo", "deprecated", { skipEvalGate: false });
      expect(bodyOf(ctx).statusCode).toBe(200);
    });

    it("POST /api/admin/skills/:slug/archive calls adminTransitionLifecycle('archived')", async () => {
      const { router, skillService } = setup();
      const ctx = makeCtx("POST", "/api/admin/skills/demo/archive", new URLSearchParams(), {});
      await router.dispatch(ctx);
      expect(skillService.adminTransitionLifecycle).toHaveBeenCalledWith("demo", "archived", { skipEvalGate: false });
      expect(bodyOf(ctx).statusCode).toBe(200);
    });

    it("POST /api/admin/skills/:slug/republish maps to 'published'", async () => {
      const { router, skillService } = setup();
      const ctx = makeCtx("POST", "/api/admin/skills/demo/republish", new URLSearchParams(), {});
      await router.dispatch(ctx);
      expect(skillService.adminTransitionLifecycle).toHaveBeenCalledWith("demo", "published", { skipEvalGate: false });
      expect(bodyOf(ctx).statusCode).toBe(200);
    });

    it("POST /api/admin/skills/:slug/republish?force=true forwards skipEvalGate=true", async () => {
      const { router, skillService } = setup();
      const ctx = makeCtx("POST", "/api/admin/skills/demo/republish", new URLSearchParams("force=true"), {});
      await router.dispatch(ctx);
      expect(skillService.adminTransitionLifecycle).toHaveBeenCalledWith("demo", "published", { skipEvalGate: true });
    });

    it("POST /api/admin/skills/:slug/publish returns 409 when service throws IllegalTransitionError", async () => {
      const { router, skillService } = setup();
      skillService.adminTransitionLifecycle = vi.fn().mockRejectedValue(new IllegalTransitionError("archived", "published"));
      const ctx = makeCtx("POST", "/api/admin/skills/demo/publish", new URLSearchParams(), {});
      await router.dispatch(ctx);
      const out = bodyOf(ctx);
      expect(out.statusCode).toBe(409);
      expect((out.body as { code: string }).code).toBe("ILLEGAL_LIFECYCLE_TRANSITION");
    });

    it("GET /api/admin/skills/:slug/lifecycle/next returns the next-state set", async () => {
      const { router, skillService } = setup();
      const ctx = makeCtx("GET", "/api/admin/skills/demo/lifecycle/next");
      await router.dispatch(ctx);
      expect(skillService.getNextLifecycleStates).toHaveBeenCalledWith("demo");
      const out = bodyOf(ctx);
      expect(out.statusCode).toBe(200);
      expect((out.body as { data: { next: string[] } }).data.next).toEqual(["published", "archived"]);
    });
  });
});
