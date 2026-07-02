import { describe, it, expect, vi, beforeEach } from "vitest";
import { Router } from "@/http/router.js";
import { errorMap } from "@/http/middleware/error-map.js";
import { registerAdminWebhookRoutes } from "@/http/handlers/admin/webhooks.handler.js";
import type { HttpContext } from "@/http/context.js";
import type { AppDependencies } from "@/app-dependencies.js";
import type { WebhookEntity } from "@/db/repositories/webhook.repository.js";
import type { WebhookDeliveryEntity } from "@/db/repositories/webhook-delivery.repository.js";
import type { Mock } from "vitest";

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

function makeCtx(method: string, url: string, body?: string): HttpContext {
  let dataHandler: ((chunk: Buffer) => void) | undefined;
  let endHandler: (() => void) | undefined;
  const req = {
    headers: {},
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === "data") dataHandler = handler as (chunk: Buffer) => void;
      if (event === "end") endHandler = handler as () => void;
      if (event === "error") { /* noop */ }
      setImmediate(() => {
        if (body && dataHandler) dataHandler(Buffer.from(body));
        if (endHandler) endHandler();
      });
      return req;
    },
    destroy() { /* noop */ },
  } as never;
  const params: Record<string, string> = {};
  const queryParts = url.split("?");
  return {
    req, res: makeRes(),
    url: queryParts[0], method, params,
    query: new URLSearchParams(queryParts[1] ?? ""),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    requestContext: { userId: "admin-1", userType: "superadmin" } as never,
  };
}

function jsonOf(ctx: HttpContext) {
  const r = ctx.res as unknown as { statusCode: number; _body: () => string };
  return { statusCode: r.statusCode, body: JSON.parse(r._body()) };
}

const sampleWebhook: WebhookEntity = {
  id: "wh1",
  url: "https://example.com/hook",
  secret: "deadbeef".repeat(8),
  eventTypes: ["skill.published"],
  enabled: true,
  description: null,
  createdAt: 1000,
  updatedAt: 1000,
  secretRotatedAt: null,
};

const sampleDelivery: WebhookDeliveryEntity = {
  id: "d1",
  webhookId: "wh1",
  eventType: "skill.published",
  deliveryId: "uuid-1",
  payload: '{"x":1}',
  attempt: 1,
  status: "success",
  responseStatus: 200,
  responseBody: "ok",
  errorMessage: null,
  nextRetryAt: null,
  firstAttemptedAt: 1500,
  lastAttemptedAt: 1500,
  completedAt: 1500,
  createdAt: 1000,
};

interface WebhookTestCtx {
  router: Router;
  create: Mock;
  update: Mock;
  findById: Mock;
  rotateSecret: Mock;
  deleteFn: Mock;
  listAll: Mock;
  listByWebhook: Mock;
  findDeliveryById: Mock;
  reschedule: Mock;
}

function setup(opts: { withDeps?: boolean } = {}): WebhookTestCtx {
  const create = vi.fn().mockReturnValue(sampleWebhook);
  const update = vi.fn().mockReturnValue({ ...sampleWebhook, enabled: false });
  const findById = vi.fn().mockReturnValue(sampleWebhook);
  const rotateSecret = vi.fn().mockReturnValue({ ...sampleWebhook, secret: "rotated".repeat(10) });
  const deleteFn = vi.fn();
  const listAll = vi.fn().mockReturnValue([sampleWebhook]);
  const listByWebhook = vi.fn().mockReturnValue([sampleDelivery]);
  const findDeliveryById = vi.fn().mockReturnValue({ ...sampleDelivery, status: "dead_letter" });
  const reschedule = vi.fn().mockReturnValue({ ...sampleDelivery, status: "pending" });

  const webhookService = { create, update, findById, rotateSecret, delete: deleteFn };
  const webhookRepo = { listAll };
  const webhookDeliveryRepo = { listByWebhook, findById: findDeliveryById, reschedule };

  const router = new Router();
  router.use(errorMap("Admin operation failed"));
  registerAdminWebhookRoutes(router, {
    webhookService: opts.withDeps === false ? undefined : webhookService,
    webhookRepo: opts.withDeps === false ? undefined : webhookRepo,
    webhookDeliveryRepo: opts.withDeps === false ? undefined : webhookDeliveryRepo,
  } as unknown as AppDependencies);

  return { router, create, update, findById, rotateSecret, deleteFn, listAll, listByWebhook, findDeliveryById, reschedule };
}

describe("registerAdminWebhookRoutes (P1-16)", () => {
  let s: WebhookTestCtx;
  beforeEach(() => { s = setup(); });

  it("GET list returns webhooks without secret", async () => {
    const ctx = makeCtx("GET", "/api/admin/webhooks");
    await s.router.dispatch(ctx);
    const out = jsonOf(ctx);
    expect(out.statusCode).toBe(200);
    expect(out.body.data[0]).toMatchObject({ id: "wh1", url: "https://example.com/hook", enabled: true });
    expect(out.body.data[0].secret).toBeUndefined();
    expect(s.listAll).toHaveBeenCalled();
  });

  it("POST create returns secret ONCE", async () => {
    const body = JSON.stringify({ url: "https://example.com/hook", event_types: ["skill.published"] });
    const ctx = makeCtx("POST", "/api/admin/webhooks", body);
    await s.router.dispatch(ctx);
    const out = jsonOf(ctx);
    expect(out.statusCode).toBe(201);
    expect(out.body.data.secret).toBe(sampleWebhook.secret);
    expect(s.create).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://example.com/hook",
      eventTypes: ["skill.published"],
    }));
  });

  it("POST create rejects missing url with 400", async () => {
    const ctx = makeCtx("POST", "/api/admin/webhooks", JSON.stringify({ event_types: ["skill.published"] }));
    await s.router.dispatch(ctx);
    expect(jsonOf(ctx).statusCode).toBe(400);
    expect(s.create).not.toHaveBeenCalled();
  });

  it("GET detail hides secret", async () => {
    const ctx = makeCtx("GET", "/api/admin/webhooks/wh1");
    await s.router.dispatch(ctx);
    const out = jsonOf(ctx);
    expect(out.statusCode).toBe(200);
    expect(out.body.data.secret).toBeUndefined();
    expect(s.findById).toHaveBeenCalledWith("wh1");
  });

  it("GET detail returns 404 when not found", async () => {
    s.findById.mockReturnValueOnce(null);
    const ctx = makeCtx("GET", "/api/admin/webhooks/wh-missing");
    await s.router.dispatch(ctx);
    expect(jsonOf(ctx).statusCode).toBe(404);
  });

  it("PUT update calls service.update with the diff", async () => {
    const ctx = makeCtx("PUT", "/api/admin/webhooks/wh1", JSON.stringify({ enabled: false }));
    await s.router.dispatch(ctx);
    expect(jsonOf(ctx).statusCode).toBe(200);
    expect(s.update).toHaveBeenCalledWith("wh1", expect.objectContaining({ enabled: false }));
  });

  it("POST rotate returns the new secret", async () => {
    const ctx = makeCtx("POST", "/api/admin/webhooks/wh1/rotate");
    await s.router.dispatch(ctx);
    const out = jsonOf(ctx);
    expect(out.statusCode).toBe(200);
    expect(out.body.data.secret).toMatch(/rotated/);
    expect(s.rotateSecret).toHaveBeenCalledWith("wh1");
  });

  it("DELETE removes the row", async () => {
    const ctx = makeCtx("DELETE", "/api/admin/webhooks/wh1");
    await s.router.dispatch(ctx);
    expect(jsonOf(ctx).statusCode).toBe(200);
    expect(s.deleteFn).toHaveBeenCalledWith("wh1");
  });

  it("GET deliveries lists rows with snake_case", async () => {
    const ctx = makeCtx("GET", "/api/admin/webhooks/wh1/deliveries?limit=20");
    await s.router.dispatch(ctx);
    const out = jsonOf(ctx);
    expect(out.statusCode).toBe(200);
    expect(out.body.data[0]).toMatchObject({
      id: "d1",
      webhook_id: "wh1",
      event_type: "skill.published",
      response_status: 200,
    });
    expect(s.listByWebhook).toHaveBeenCalledWith("wh1", 20);
  });

  it("POST replay reschedules a dead-lettered delivery", async () => {
    const ctx = makeCtx("POST", "/api/admin/webhook-deliveries/d1/replay");
    await s.router.dispatch(ctx);
    const out = jsonOf(ctx);
    expect(out.statusCode).toBe(202);
    expect(out.body.data.status).toBe("pending");
    expect(s.reschedule).toHaveBeenCalledWith("d1");
  });

  it("POST replay returns 404 when delivery missing", async () => {
    s.findDeliveryById.mockReturnValueOnce(null);
    const ctx = makeCtx("POST", "/api/admin/webhook-deliveries/missing/replay");
    await s.router.dispatch(ctx);
    expect(jsonOf(ctx).statusCode).toBe(404);
    expect(s.reschedule).not.toHaveBeenCalled();
  });

  it("does not register routes when deps unset", async () => {
    const router = new Router();
    router.use(errorMap("Admin operation failed"));
    registerAdminWebhookRoutes(router, {} as AppDependencies);
    const ctx = makeCtx("GET", "/api/admin/webhooks");
    const dispatched = await router.dispatch(ctx);
    expect(dispatched).toBe(false);
  });
});
