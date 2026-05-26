import { describe, it, expect, vi } from "vitest";
import { compose, wrapHandler, named, type Middleware } from "@/http/compose.js";
import type { HttpContext } from "@/http/context.js";

const fakeCtx = (): HttpContext => ({
  req: {} as never,
  res: {} as never,
  url: "/test",
  method: "GET",
  params: {},
  query: new URLSearchParams(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
});

describe("compose (T-101)", () => {
  it("invokes middleware in registration order, leaf last", async () => {
    const calls: string[] = [];
    const mw1: Middleware = async (_ctx, next) => { calls.push("mw1-pre"); await next(); calls.push("mw1-post"); };
    const mw2: Middleware = async (_ctx, next) => { calls.push("mw2-pre"); await next(); calls.push("mw2-post"); };
    const handler = wrapHandler(async () => { calls.push("handler"); });
    await compose([mw1, mw2, handler])(fakeCtx(), async () => {});
    expect(calls).toEqual(["mw1-pre", "mw2-pre", "handler", "mw2-post", "mw1-post"]);
  });

  it("invokes finalNext when middleware list is empty", async () => {
    const finalNext = vi.fn(async () => {});
    await compose([])(fakeCtx(), finalNext);
    expect(finalNext).toHaveBeenCalledTimes(1);
  });

  it("short-circuits when middleware does not call next", async () => {
    const calls: string[] = [];
    const guard: Middleware = async () => { calls.push("guard"); /* no next() */ };
    const handler = wrapHandler(async () => { calls.push("handler"); });
    await compose([guard, handler])(fakeCtx(), async () => {});
    expect(calls).toEqual(["guard"]);
  });

  it("propagates errors thrown downstream up the chain", async () => {
    const calls: string[] = [];
    const wrapper: Middleware = async (_ctx, next) => {
      try { await next(); } catch (err) { calls.push(`caught:${(err as Error).message}`); }
    };
    const failing = wrapHandler(async () => { throw new Error("boom"); });
    await compose([wrapper, failing])(fakeCtx(), async () => {});
    expect(calls).toEqual(["caught:boom"]);
  });

  it("rejects double next() within the same middleware", async () => {
    const broken: Middleware = async (_ctx, next) => { await next(); await next(); };
    const handler = wrapHandler(async () => {});
    await expect(
      compose([broken, handler])(fakeCtx(), async () => {}),
    ).rejects.toThrow(/next\(\) called multiple times/);
  });

  it("names the offending middleware in the double-next error", async () => {
    const broken = named("brokenAuth", async (_ctx, next) => { await next(); await next(); });
    const handler = wrapHandler(async () => {});
    await expect(
      compose([broken, handler])(fakeCtx(), async () => {}),
    ).rejects.toThrow(/brokenAuth/);
  });
});
