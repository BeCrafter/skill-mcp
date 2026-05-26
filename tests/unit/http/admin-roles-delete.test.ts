import { describe, it, expect, vi } from "vitest";
import { Router } from "@/http/router.js";
import { registerAdminRoleRoutes } from "@/http/handlers/admin/roles.handler.js";
import type { HttpContext } from "@/http/context.js";
import type { AppDependencies } from "@/app-dependencies.js";

function makeRes() {
  return { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), statusCode: 0 } as never;
}

function makeCtx(method: string, url: string): HttpContext {
  const req = {
    headers: {},
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "end") cb();
      return this;
    },
  } as never;
  return {
    req, res: makeRes(),
    url, method, params: {}, query: new URLSearchParams(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  };
}

describe("DELETE /api/admin/roles/:roleId publishes role:updated (T-731)", () => {
  it("publishes role:updated with affectedUserIds so cache subscriber can invalidate", async () => {
    const userRoleRepo = {
      findUserIdsByRoleId: vi.fn().mockResolvedValue(["u1", "u2"]),
      deleteByRoleId: vi.fn().mockResolvedValue(undefined),
    };
    const roleRepo = {
      delete: vi.fn().mockResolvedValue(true),
    };
    const userRepo = {} as never;
    const eventBus = { publish: vi.fn() };

    const router = new Router();
    registerAdminRoleRoutes(router, {
      roleRepo, userRoleRepo, userRepo, eventBus,
    } as unknown as AppDependencies);

    const ctx = makeCtx("DELETE", "/api/admin/roles/r-1");
    await router.dispatch(ctx);

    // Affected users captured *before* cascade so the user list isn't lost.
    expect(userRoleRepo.findUserIdsByRoleId).toHaveBeenCalledWith("r-1");
    expect(eventBus.publish).toHaveBeenCalledWith({
      type: "role:updated",
      roleId: "r-1",
      affectedUserIds: ["u1", "u2"],
    });
  });

  it("does not publish when role not found (404)", async () => {
    const userRoleRepo = {
      findUserIdsByRoleId: vi.fn().mockResolvedValue([]),
      deleteByRoleId: vi.fn().mockResolvedValue(undefined),
    };
    const roleRepo = {
      delete: vi.fn().mockResolvedValue(false),
    };
    const eventBus = { publish: vi.fn() };

    const router = new Router();
    registerAdminRoleRoutes(router, {
      roleRepo, userRoleRepo, userRepo: {} as never, eventBus,
    } as unknown as AppDependencies);

    const ctx = makeCtx("DELETE", "/api/admin/roles/missing");
    await router.dispatch(ctx).catch(() => undefined);

    expect(eventBus.publish).not.toHaveBeenCalled();
  });
});
