import { describe, it, expect, vi } from "vitest";
import { Router } from "@/http/router.js";
import { registerAdminSkillRoutes } from "@/http/handlers/admin/skills.handler.js";
import type { HttpContext } from "@/http/context.js";
import type { AppDependencies } from "@/app-dependencies.js";

function makeRes() {
  return {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    statusCode: 0,
  } as never;
}

function makeCtx(method: string, url: string, body: unknown): HttpContext {
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
    res: makeRes(),
    url,
    method,
    params: {},
    query: new URLSearchParams(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  };
}

describe("PUT /api/admin/skills/:slug — body projection (T-728)", () => {
  it("strips storagePath/contentHash from caller-supplied body before forwarding to repo", async () => {
    const skillRepo = {
      findBySlug: vi.fn().mockResolvedValue({
        id: "s1", slug: "demo", visibility: "private", tags: [],
        storagePath: "skills/demo/", contentHash: "original",
      }),
      update: vi.fn().mockResolvedValue({
        id: "s1", slug: "demo", visibility: "private", tags: [],
        storagePath: "skills/demo/", contentHash: "original",
        description: "new", createdAt: 1, updatedAt: 1,
        name: "demo", displayName: null, version: "0.0.1",
        category: null, attributes: {}, status: "draft", entryFile: "SKILL.md",
      }),
    };
    const eventBus = { publish: vi.fn() };

    const router = new Router();
    registerAdminSkillRoutes(router, {
      skillRepo, eventBus,
    } as unknown as AppDependencies);

    const ctx = makeCtx("PUT", "/api/admin/skills/demo", {
      description: "new",
      storagePath: "../etc/passwd/",
      contentHash: "tampered",
      tags: ["x"],
    });

    await router.dispatch(ctx);

    expect(skillRepo.update).toHaveBeenCalledTimes(1);
    const projected = skillRepo.update.mock.calls[0][1];
    expect(projected.description).toBe("new");
    expect(projected.tags).toEqual(["x"]);
    expect(projected).not.toHaveProperty("storagePath");
    expect(projected).not.toHaveProperty("contentHash");
  });
});
