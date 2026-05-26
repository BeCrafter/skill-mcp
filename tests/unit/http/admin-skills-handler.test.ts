import { describe, it, expect, vi } from "vitest";
import { Router } from "@/http/router.js";
import { errorMap } from "@/http/middleware/error-map.js";
import { registerAdminSkillRoutes } from "@/http/handlers/admin/skills.handler.js";
import type { HttpContext } from "@/http/context.js";
import type { AppDependencies } from "@/app-dependencies.js";

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

function setup() {
  const skillRepo = {
    findAll: vi.fn().mockResolvedValue([
      { id: "s1", slug: "a", name: "A", visibility: "private", tags: [], status: "published", storagePath: "a/", createdAt: 1, updatedAt: 1, version: "1", attributes: {}, entryFile: "SKILL.md", displayName: null, category: null, description: "" },
      { id: "s2", slug: "b", name: "B", visibility: "private", tags: [], status: "published", storagePath: "b/", createdAt: 1, updatedAt: 1, version: "1", attributes: {}, entryFile: "SKILL.md", displayName: null, category: null, description: "" },
      { id: "s3", slug: "c", name: "C", visibility: "private", tags: [], status: "published", storagePath: "c/", createdAt: 1, updatedAt: 1, version: "1", attributes: {}, entryFile: "SKILL.md", displayName: null, category: null, description: "" },
    ]),
    findBySlug: vi.fn(async (slug: string) => (
      slug === "demo"
        ? { id: "s1", slug: "demo", visibility: "private", tags: ["x"], storagePath: "demo/", contentHash: "h", name: "demo", displayName: null, description: "", version: "1", category: null, attributes: {}, status: "published", entryFile: "SKILL.md", createdAt: 1, updatedAt: 1 }
        : null
    )),
    findByName: vi.fn().mockResolvedValue([{ id: "s1", slug: "demo", name: "demo", visibility: "private", tags: [], status: "published", storagePath: "demo/", createdAt: 1, updatedAt: 1, version: "1", attributes: {}, entryFile: "SKILL.md", displayName: null, category: null, description: "" }]),
    update: vi.fn(async (id: string, fields: Record<string, unknown>) => ({ id, slug: "demo", visibility: "private", tags: ["x"], storagePath: "demo/", contentHash: "h", name: "demo", displayName: null, description: "", version: "1", category: null, attributes: {}, status: "published", entryFile: "SKILL.md", createdAt: 1, updatedAt: 1, ...fields })),
    delete: vi.fn().mockResolvedValue(true),
    count: vi.fn().mockResolvedValue(42),
  };
  const skillProvider = {
    getSkillEntry: vi.fn().mockResolvedValue("# entry"),
    getSkillFiles: vi.fn().mockResolvedValue([{ filePath: "a.md", content: "x" }]),
    getSkillFileTree: vi.fn().mockResolvedValue([{ filePath: "a.md" }]),
  };
  const storage = { deleteDir: vi.fn().mockResolvedValue(undefined) };
  const importer = { import: vi.fn().mockResolvedValue({ skill: { slug: "imported" } }) };
  const accessLogRepo = { findBySkill: vi.fn().mockResolvedValue([{ id: "log1" }]) };
  const skillService = {
    getEffectivenessRates: vi.fn().mockResolvedValue(new Map([
      ["good", { rate: 0.9, count: 50 }],
      ["middling", { rate: 0.6, count: 20 }],
      ["bad", { rate: 0.2, count: 30 }],
      ["new", { rate: 0.1, count: 3 }],
    ])),
    getVersions: vi.fn().mockResolvedValue([{ version: "1.0.0" }]),
    rollbackToVersion: vi.fn().mockResolvedValue(undefined),
  };
  const eventBus = { publish: vi.fn() };
  const router = new Router();
  router.use(errorMap());
  registerAdminSkillRoutes(router, {
    skillRepo, skillProvider, storage, importer, accessLogRepo, eventBus, skillService,
  } as unknown as AppDependencies);
  return { router, skillRepo, skillProvider, storage, importer, accessLogRepo, eventBus, skillService };
}

describe("registerAdminSkillRoutes — coverage extension", () => {
  it("GET /api/admin/skills paginates and projects to public meta", async () => {
    const { router, skillRepo } = setup();
    const ctx = makeCtx("GET", "/api/admin/skills", new URLSearchParams({ offset: "1", limit: "1", "attributes.lang": "zh" }));
    await router.dispatch(ctx);
    expect(skillRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ attributes: { lang: "zh" } }));
    const out = bodyOf(ctx);
    expect(out.statusCode).toBe(200);
    const data = (out.body as { data: unknown[]; total: number }).data;
    expect(data).toHaveLength(1);
    // toSkillMetaPublic should not leak storagePath or contentHash
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

  it("GET /api/admin/skills/name/:name forwards to findByName", async () => {
    const { router, skillRepo } = setup();
    const ctx = makeCtx("GET", "/api/admin/skills/name/demo");
    await router.dispatch(ctx);
    expect(skillRepo.findByName).toHaveBeenCalledWith("demo");
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

  it("DELETE /api/admin/skills/:slug deletes storage then row, then publishes skill:deleted", async () => {
    const { router, storage, skillRepo, eventBus } = setup();
    const ctx = makeCtx("DELETE", "/api/admin/skills/demo");
    await router.dispatch(ctx);
    expect(storage.deleteDir).toHaveBeenCalledWith("demo/");
    expect(skillRepo.delete).toHaveBeenCalledWith("demo");
    expect(eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: "skill:deleted", slug: "demo" }));
    const storageOrder = storage.deleteDir.mock.invocationCallOrder[0];
    const dbOrder = skillRepo.delete.mock.invocationCallOrder[0];
    expect(storageOrder).toBeLessThan(dbOrder);
  });

  it("GET /api/admin/skills/:slug/entry serves text/markdown", async () => {
    const { router } = setup();
    const ctx = makeCtx("GET", "/api/admin/skills/demo/entry");
    await router.dispatch(ctx);
    const out = bodyOf(ctx);
    expect(out.statusCode).toBe(200);
    expect(String(out.headers["Content-Type"])).toMatch(/text\/markdown/);
  });

  it("POST /api/admin/skills/:slug/files validates body via requireFilePaths", async () => {
    const { router, skillProvider } = setup();
    const ctx = makeCtx("POST", "/api/admin/skills/demo/files", new URLSearchParams(), { paths: ["a.md"] });
    await router.dispatch(ctx);
    expect(skillProvider.getSkillFiles).toHaveBeenCalledWith("demo", ["a.md"]);
  });

  it("POST /api/admin/skills/:slug/files rejects empty paths with 400", async () => {
    const { router } = setup();
    const ctx = makeCtx("POST", "/api/admin/skills/demo/files", new URLSearchParams(), { paths: [] });
    await router.dispatch(ctx);
    expect(bodyOf(ctx).statusCode).toBe(400);
  });

  it("GET /api/admin/skills/:slug/file-tree calls provider", async () => {
    const { router, skillProvider } = setup();
    const ctx = makeCtx("GET", "/api/admin/skills/demo/file-tree");
    await router.dispatch(ctx);
    expect(skillProvider.getSkillFileTree).toHaveBeenCalledWith("demo");
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

  it("POST /api/admin/skills calls importer with normalized options + defaults", async () => {
    const { router, importer } = setup();
    const ctx = makeCtx("POST", "/api/admin/skills", new URLSearchParams(), {
      source: "/local/path", tags: ["t"], category: "ai",
    });
    await router.dispatch(ctx);
    expect(importer.import).toHaveBeenCalledWith("/local/path", expect.objectContaining({
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
    const { router, accessLogRepo } = setup();
    const ctx = makeCtx("GET", "/api/admin/logs", new URLSearchParams({ skill_slug: "demo", limit: "9999" }));
    await router.dispatch(ctx);
    expect(accessLogRepo.findBySkill).toHaveBeenCalledWith("demo", 200);
  });

  it("GET /api/admin/stats returns total skill count", async () => {
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

  it("POST /api/admin/skills/:slug/rollback publishes skill:updated after rollback", async () => {
    const { router, skillService, eventBus } = setup();
    const ctx = makeCtx("POST", "/api/admin/skills/demo/rollback", new URLSearchParams(), { version: "1.0.0", bump: "minor" });
    await router.dispatch(ctx);
    expect(skillService.rollbackToVersion).toHaveBeenCalledWith("demo", "1.0.0", "minor");
    expect(eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: "skill:updated", slug: "demo" }));
    expect(bodyOf(ctx).statusCode).toBe(200);
  });
});
