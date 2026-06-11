import { describe, it, expect, vi } from "vitest";
import { Router } from "@/http/router.js";
import { errorMap } from "@/http/middleware/error-map.js";
import { registerAdminSkillRoutes } from "@/http/handlers/admin/skills.handler.js";
import { SkillService } from "@/services/skill.service.js";
import type { HttpContext } from "@/http/context.js";
import type { AppDependencies } from "@/app-dependencies.js";

/**
 * P1-11 stage 2b — admin REST endpoint
 *   PUT /api/admin/skills/:slug/retrieval
 * accepts retrieval-meta patches in either snake_case or camelCase,
 * accepts a literal `null` body to clear all three fields, and rejects
 * oversize entries via the SkillService cap checks.
 */

const SKILL = (slug: string, retrievalMeta: unknown = null) => ({
  id: `id-${slug}`,
  slug,
  name: slug,
  displayName: null,
  description: `desc for ${slug}`,
  version: "0.0.1",
  category: null,
  tags: [],
  attributes: {},
  status: "draft" as const,
  visibility: "private" as const,
  entryFile: "SKILL.md",
  storagePath: `${slug}/`,
  contentHash: "h",
  createdAt: 1,
  updatedAt: 1,
  retrievalMeta,
});

function makeRes() {
  const res = {
    statusCode: 0,
    _bodyChunks: [] as string[],
    _headers: {} as Record<string, string>,
    writeHead: vi.fn(function (this: typeof res, code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      if (headers) Object.assign(this._headers, headers);
    }),
    write: vi.fn(),
    end: vi.fn(function (this: typeof res, chunk?: string) {
      if (chunk) this._bodyChunks.push(chunk);
    }),
  };
  return res;
}

function makeCtx(method: string, url: string, body: unknown): HttpContext & { res: ReturnType<typeof makeRes> } {
  const bodyStr = JSON.stringify(body);
  const chunks = [Buffer.from(bodyStr)];
  const req = {
    headers: { "content-type": "application/json", "content-length": String(bodyStr.length) },
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "data") chunks.forEach((c) => cb(c));
      if (event === "end") cb();
      return this;
    },
  } as never;
  return {
    req,
    res: makeRes() as never,
    url,
    method,
    params: {},
    query: new URLSearchParams(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  } as never;
}

function makeService(opts: {
  current?: ReturnType<typeof SKILL> | null;
  capturedPatch?: { value?: unknown };
} = {}) {
  const skillRepo = {
    findBySlug: vi.fn().mockResolvedValue(opts.current ?? SKILL("demo", null)),
    update: vi.fn().mockImplementation(async (_id, patch) => {
      if (opts.capturedPatch) opts.capturedPatch.value = patch.retrievalMeta;
      return { ...(opts.current ?? SKILL("demo", null)), retrievalMeta: patch.retrievalMeta };
    }),
  };
  const eventBus = { publish: vi.fn() };
  const svc = new SkillService(
    {} as never, {} as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    {} as never, {} as never, {} as never,
    skillRepo as never,
    {} as never,
    undefined, undefined,
    { eventBus: eventBus as never },
  );
  return { svc, skillRepo, eventBus };
}

async function dispatch(svc: SkillService, ctx: ReturnType<typeof makeCtx>) {
  const router = new Router();
  router.use(errorMap());
  registerAdminSkillRoutes(router, { skillService: svc } as unknown as AppDependencies);
  await router.dispatch(ctx as never);
  return ctx;
}

describe("PUT /api/admin/skills/:slug/retrieval", () => {
  it("accepts snake_case keys", async () => {
    const captured: { value?: unknown } = {};
    const { svc } = makeService({ capturedPatch: captured });
    const ctx = makeCtx("PUT", "/api/admin/skills/demo/retrieval", {
      triggers: ["a", "b"],
      when_to_use: "when X",
      embedding_text: "embed",
    });
    await dispatch(svc, ctx);
    expect(ctx.res.statusCode).toBe(200);
    expect(captured.value).toEqual({ triggers: ["a", "b"], whenToUse: "when X", embeddingText: "embed" });
  });

  it("accepts camelCase keys", async () => {
    const captured: { value?: unknown } = {};
    const { svc } = makeService({ capturedPatch: captured });
    const ctx = makeCtx("PUT", "/api/admin/skills/demo/retrieval", {
      triggers: ["x"],
      whenToUse: "u",
      embeddingText: "e",
    });
    await dispatch(svc, ctx);
    expect(ctx.res.statusCode).toBe(200);
    expect(captured.value).toEqual({ triggers: ["x"], whenToUse: "u", embeddingText: "e" });
  });

  it("clears all retrieval fields when body is null", async () => {
    const captured: { value?: unknown } = {};
    const { svc } = makeService({
      current: SKILL("demo", { triggers: ["x"], whenToUse: "u", embeddingText: "e" }),
      capturedPatch: captured,
    });
    const ctx = makeCtx("PUT", "/api/admin/skills/demo/retrieval", null);
    await dispatch(svc, ctx);
    expect(ctx.res.statusCode).toBe(200);
    expect(captured.value).toBeNull();
  });

  it("rejects oversize embeddingText with 400", async () => {
    const { svc } = makeService();
    const ctx = makeCtx("PUT", "/api/admin/skills/demo/retrieval", {
      embedding_text: "x".repeat(8193),
    });
    await dispatch(svc, ctx);
    expect(ctx.res.statusCode).toBe(400);
  });

  it("rejects > 32 triggers with 400", async () => {
    const { svc } = makeService();
    const ctx = makeCtx("PUT", "/api/admin/skills/demo/retrieval", {
      triggers: Array.from({ length: 33 }, (_, i) => `t${i}`),
    });
    await dispatch(svc, ctx);
    expect(ctx.res.statusCode).toBe(400);
  });

  it("returns 404 when slug not found", async () => {
    const { svc, skillRepo } = makeService();
    skillRepo.findBySlug.mockResolvedValue(null);
    const ctx = makeCtx("PUT", "/api/admin/skills/ghost/retrieval", { triggers: [] });
    await dispatch(svc, ctx);
    expect(ctx.res.statusCode).toBe(404);
  });

  it("publishes skill:updated event after a successful patch", async () => {
    const { svc, eventBus } = makeService();
    const ctx = makeCtx("PUT", "/api/admin/skills/demo/retrieval", { triggers: ["x"] });
    await dispatch(svc, ctx);
    expect(ctx.res.statusCode).toBe(200);
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "skill:updated", slug: "demo" }),
    );
  });

  it("merges partial patch — preserves untouched fields", async () => {
    const captured: { value?: unknown } = {};
    const { svc } = makeService({
      current: SKILL("demo", { triggers: ["existing"], whenToUse: "existing", embeddingText: "existing" }),
      capturedPatch: captured,
    });
    const ctx = makeCtx("PUT", "/api/admin/skills/demo/retrieval", { triggers: ["new"] });
    await dispatch(svc, ctx);
    expect(captured.value).toEqual({ triggers: ["new"], whenToUse: "existing", embeddingText: "existing" });
  });
});
