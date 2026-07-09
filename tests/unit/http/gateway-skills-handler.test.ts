import { describe, it, expect, vi } from "vitest";
import { Router } from "@/http/router.js";
import { errorMap } from "@/http/middleware/error-map.js";
import { registerGatewaySkillRoutes } from "@/http/handlers/gateway/skills.handler.js";
import type { HttpContext } from "@/http/context.js";
import type { AppDependencies } from "@/app-dependencies.js";

function makeRes() {
  const headers: Record<string, unknown> = {};
  let body = "";
  const res = {
    statusCode: 0,
    writeHead: vi.fn((status: number, h?: Record<string, unknown>) => {
      res.statusCode = status;
      if (h) Object.assign(headers, h);
    }),
    setHeader: vi.fn((k: string, v: unknown) => { headers[k] = v; }),
    write: vi.fn(),
    end: vi.fn((chunk?: string | Buffer) => { if (chunk) body += chunk.toString(); }),
    _headers: headers,
    _body: () => body,
  };
  return res as unknown as ReturnType<typeof realRes>;
}
type realRes = () => { statusCode: number; _headers: Record<string, unknown>; _body: () => string };

function makeCtx(method: string, url: string, query = new URLSearchParams(), body?: unknown): HttpContext {
  const req = {
    headers: {},
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "data" && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
      return this;
    },
  } as never;
  return {
    req, res: makeRes() as never,
    url, method, params: {}, query,
    requestContext: { userId: "u1", tags: ["alpha"], isAnonymous: false } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  };
}

function fakeService(): AppDependencies["skillService"] {
  return {
    listAccessibleSkills: vi.fn().mockResolvedValue([
      { slug: "a", name: "A" }, { slug: "b", name: "B" }, { slug: "c", name: "C" },
    ]),
    getAccessibleSkillMeta: vi.fn().mockResolvedValue({ slug: "a", name: "A" }),
    getAccessibleEntryRaw: vi.fn().mockResolvedValue("# entry"),
    readSkillFiles: vi.fn().mockResolvedValue([{ filePath: "a.md", content: "x" }]),
    getAccessibleFileTree: vi.fn().mockResolvedValue([{ filePath: "a.md" }]),
  } as unknown as AppDependencies["skillService"];
}

function setup(svc = fakeService()): Router {
  const router = new Router();
  router.use(errorMap());
  registerGatewaySkillRoutes(router, { skillService: svc } as AppDependencies);
  return router;
}

describe("registerGatewaySkillRoutes", () => {
  it("GET /api/gateway/skills paginates and forwards filters", async () => {
    const svc = fakeService();
    const router = setup(svc);
    const query = new URLSearchParams({ category: "ai", tags: "x,y", offset: "1", limit: "2", "attributes.lang": "zh" });
    const ctx = makeCtx("GET", "/api/gateway/skills", query);
    await router.dispatch(ctx);
    expect(svc.listAccessibleSkills).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1" }),
      { category: "ai", tags: ["x", "y"], attributes: { lang: "zh" } },
    );
    const body = JSON.parse((ctx.res as never as { _body: () => string })._body());
    expect(body.total).toBe(3);
    expect(body.offset).toBe(1);
    expect(body.limit).toBe(2);
    expect(body.data).toHaveLength(2);
  });

  it("GET /api/gateway/skills omits attributes when none given", async () => {
    const svc = fakeService();
    const router = setup(svc);
    const ctx = makeCtx("GET", "/api/gateway/skills");
    await router.dispatch(ctx);
    expect(svc.listAccessibleSkills).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attributes: undefined }),
    );
  });

  it("GET /api/gateway/skills/:identifier accepts a slug", async () => {
    const svc = fakeService();
    const router = setup(svc);
    const ctx = makeCtx("GET", "/api/gateway/skills/my-skill");
    await router.dispatch(ctx);
    expect(svc.getAccessibleSkillMeta).toHaveBeenCalledWith("my-skill", expect.anything());
    expect((ctx.res as never as { statusCode: number }).statusCode).toBe(200);
  });

  it("GET /api/gateway/skills/:identifier accepts a UUID", async () => {
    const svc = fakeService();
    const router = setup(svc);
    const uuid = "12345678-1234-1234-1234-123456789abc";
    const ctx = makeCtx("GET", `/api/gateway/skills/${uuid}`);
    await router.dispatch(ctx);
    expect(svc.getAccessibleSkillMeta).toHaveBeenCalledWith(uuid, expect.anything());
  });

  it("GET /api/gateway/skills/:identifier rejects unsafe identifiers as 400", async () => {
    const router = setup();
    const ctx = makeCtx("GET", "/api/gateway/skills/has..dotdot");
    await router.dispatch(ctx);
    expect((ctx.res as never as { statusCode: number }).statusCode).toBe(400);
  });

  it("GET /api/gateway/skills/:slug/entry serves text/markdown", async () => {
    const router = setup();
    const ctx = makeCtx("GET", "/api/gateway/skills/demo/entry");
    await router.dispatch(ctx);
    const headers = (ctx.res as never as { _headers: Record<string, unknown> })._headers;
    expect(headers["Content-Type"]).toMatch(/text\/markdown/);
  });

  it("POST /api/gateway/skills/:slug/files validates paths body", async () => {
    const svc = fakeService();
    const router = setup(svc);
    const ctx = makeCtx("POST", "/api/gateway/skills/demo/files", new URLSearchParams(), { paths: ["a.md", "b.md"] });
    await router.dispatch(ctx);
    expect(svc.readSkillFiles).toHaveBeenCalledWith("demo", ["a.md", "b.md"], expect.anything());
  });

  it("POST /api/gateway/skills/:slug/files rejects non-array paths with 400", async () => {
    const router = setup();
    const ctx = makeCtx("POST", "/api/gateway/skills/demo/files", new URLSearchParams(), { paths: "a.md" });
    await router.dispatch(ctx);
    expect((ctx.res as never as { statusCode: number }).statusCode).toBe(400);
  });

  it("POST /api/gateway/skills/:slug/files rejects empty paths with 400", async () => {
    const router = setup();
    const ctx = makeCtx("POST", "/api/gateway/skills/demo/files", new URLSearchParams(), { paths: [] });
    await router.dispatch(ctx);
    expect((ctx.res as never as { statusCode: number }).statusCode).toBe(400);
  });

  it("GET /api/gateway/skills/:slug/file-tree returns tree", async () => {
    const svc = fakeService();
    const router = setup(svc);
    const ctx = makeCtx("GET", "/api/gateway/skills/demo/file-tree");
    await router.dispatch(ctx);
    expect(svc.getAccessibleFileTree).toHaveBeenCalledWith("demo", expect.anything());
  });

  it("GET /api/gateway/skills/:slug/file-tree rejects bad slug with 400", async () => {
    const router = setup();
    const ctx = makeCtx("GET", "/api/gateway/skills/has..dotdot/file-tree");
    await router.dispatch(ctx);
    expect((ctx.res as never as { statusCode: number }).statusCode).toBe(400);
  });
});
