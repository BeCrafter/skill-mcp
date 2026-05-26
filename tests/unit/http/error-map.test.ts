import { describe, it, expect, vi } from "vitest";
import { errorMap } from "@/http/middleware/error-map.js";
import type { HttpContext } from "@/http/context.js";
import {
  AppError,
  BadRequestError,
  SkillNotFoundError,
  PermissionDeniedError,
  UpstreamError,
} from "@/utils/errors.js";

function makeCtx(): HttpContext & { _written: { status?: number; body?: unknown }; res: ServerResponseMock } {
  const _written: { status?: number; body?: unknown } = {};
  const res: ServerResponseMock = {
    headersSent: false,
    writableEnded: false,
    writeHead: vi.fn((status: number) => { _written.status = status; res.headersSent = true; }) as never,
    end: vi.fn((body: string) => { _written.body = JSON.parse(body); res.writableEnded = true; }) as never,
    statusCode: 0,
  };
  return {
    req: {} as never,
    res: res as never,
    url: "/test",
    method: "GET",
    params: {},
    query: new URLSearchParams(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    _written,
  };
}

interface ServerResponseMock {
  headersSent: boolean;
  writableEnded: boolean;
  writeHead: (status: number, headers?: Record<string, string | number>) => void;
  end: (body: string) => void;
  statusCode: number;
}

describe("errorMap middleware (T-101)", () => {
  it("passes through when no error is thrown", async () => {
    const ctx = makeCtx();
    const mw = errorMap();
    await mw(ctx, async () => { /* no throw */ });
    expect(ctx._written.status).toBeUndefined();
  });

  it("translates BadRequestError → 400", async () => {
    const ctx = makeCtx();
    await errorMap()(ctx, async () => { throw new BadRequestError("missing source"); });
    expect(ctx._written.status).toBe(400);
    expect((ctx._written.body as { code: string }).code).toBe("BAD_REQUEST");
    expect((ctx._written.body as { error: string }).error).toBe("missing source");
  });

  it("translates SkillNotFoundError → 404", async () => {
    const ctx = makeCtx();
    await errorMap()(ctx, async () => { throw new SkillNotFoundError("ghost"); });
    expect(ctx._written.status).toBe(404);
    expect((ctx._written.body as { code: string }).code).toBe("SKILL_NOT_FOUND");
  });

  it("translates PermissionDeniedError → 403", async () => {
    const ctx = makeCtx();
    await errorMap()(ctx, async () => { throw new PermissionDeniedError("private-skill"); });
    expect(ctx._written.status).toBe(403);
    expect((ctx._written.body as { code: string }).code).toBe("PERMISSION_DENIED");
  });

  it("translates UpstreamError → 502", async () => {
    const ctx = makeCtx();
    await errorMap()(ctx, async () => { throw new UpstreamError("cloud down", 503); });
    expect(ctx._written.status).toBe(502);
    expect((ctx._written.body as { code: string }).code).toBe("UPSTREAM_ERROR");
  });

  it("translates plain Error → 500 with fallback message", async () => {
    const ctx = makeCtx();
    await errorMap("Operation failed")(ctx, async () => { throw new Error("kaboom"); });
    expect(ctx._written.status).toBe(500);
    expect((ctx._written.body as { error: string }).error).toBe("kaboom");
  });

  it("uses fallback message when error has empty message", async () => {
    const ctx = makeCtx();
    await errorMap("op-failed")(ctx, async () => { throw new Error(""); });
    expect(ctx._written.status).toBe(500);
    expect((ctx._written.body as { error: string }).error).toBe("op-failed");
  });

  it("uses warn-level logging for AppError, error-level for unknown", async () => {
    const ctx1 = makeCtx();
    await errorMap()(ctx1, async () => { throw new BadRequestError("nope"); });
    expect((ctx1.logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((ctx1.logger.error as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    const ctx2 = makeCtx();
    await errorMap()(ctx2, async () => { throw new Error("unexpected"); });
    expect((ctx2.logger.error as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((ctx2.logger.warn as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("does not double-write when headers already sent", async () => {
    const ctx = makeCtx();
    (ctx.res as ServerResponseMock).headersSent = true;
    await errorMap()(ctx, async () => { throw new BadRequestError("x"); });
    expect((ctx.res as ServerResponseMock).writeHead).not.toHaveBeenCalled();
    expect((ctx.logger.error as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("respects custom AppError subclasses", async () => {
    class WeirdError extends AppError {
      constructor() { super("teapot", "TEAPOT", 418); this.name = "WeirdError"; }
    }
    const ctx = makeCtx();
    await errorMap()(ctx, async () => { throw new WeirdError(); });
    expect(ctx._written.status).toBe(418);
    expect((ctx._written.body as { code: string }).code).toBe("TEAPOT");
  });
});
