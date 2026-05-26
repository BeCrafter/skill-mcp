import { describe, it, expect, vi } from "vitest";
import { Router } from "@/http/router.js";
import type { HttpContext } from "@/http/context.js";

function makeCtx(method: string, url: string): HttpContext {
  return {
    req: {} as never,
    res: {} as never,
    method,
    url,
    params: {},
    query: new URLSearchParams(),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
  };
}

describe("Router param extraction (T-304)", () => {
  it("returns null when no route matches", () => {
    const r = new Router();
    r.get("/api/admin/skills", async () => {});
    expect(r.match("GET", "/api/admin/users")).toBeNull();
    expect(r.match("POST", "/api/admin/skills")).toBeNull();
  });

  it("captures :param tokens and url-decodes the values", () => {
    const r = new Router();
    r.get("/api/admin/skills/:slug/files/:path", async () => {});
    const m = r.match("GET", "/api/admin/skills/my-skill/files/path%2Fwith%20space");
    expect(m).not.toBeNull();
    expect(m!.params).toEqual({ slug: "my-skill", path: "path/with space" });
  });

  it("does not match across path segments", () => {
    const r = new Router();
    r.get("/a/:x", async () => {});
    expect(r.match("GET", "/a/b/c")).toBeNull();
  });

  it("dispatch runs router-level middleware before handler and returns true on match", async () => {
    const r = new Router();
    const order: string[] = [];
    r.use(async (_ctx, next) => { order.push("mw-pre"); await next(); order.push("mw-post"); });
    r.get("/x/:id", async (ctx) => { order.push(`handler:${ctx.params.id}`); });

    const ctx = makeCtx("GET", "/x/42");
    const matched = await r.dispatch(ctx);
    expect(matched).toBe(true);
    expect(order).toEqual(["mw-pre", "handler:42", "mw-post"]);
    expect(ctx.params).toEqual({ id: "42" });
  });

  it("dispatch returns false when no route matches and does not invoke middleware", async () => {
    const r = new Router();
    const mw = vi.fn(async (_ctx, next) => { await next(); });
    r.use(mw);
    r.get("/known", async () => {});
    const matched = await r.dispatch(makeCtx("GET", "/unknown"));
    expect(matched).toBe(false);
    expect(mw).not.toHaveBeenCalled();
  });
});
