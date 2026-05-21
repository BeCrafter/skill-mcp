import { describe, it, expect, vi } from "vitest";
import { withFallbackToken, type ContextBuilder, type McpExtra } from "@/permission/context-builder.js";
import { assertStdioTokenOrExit } from "@/cli/commands/serve-stdio-auth.js";

const noopLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;

describe("withFallbackToken", () => {
  it("injects fallback token when extra has no authInfo", async () => {
    const base = vi.fn(async (extra: McpExtra) => ({
      userId: extra.authInfo?.token ?? "anon",
      sessionId: "s",
      tags: new Set<string>(),
      isAuthenticated: !!extra.authInfo?.token,
    })) as unknown as ContextBuilder;

    const wrapped = withFallbackToken(base, "fallback-tok");
    const ctx = await wrapped({});
    expect(ctx.userId).toBe("fallback-tok");
    expect(base).toHaveBeenCalledWith({ authInfo: { token: "fallback-tok" } });
  });

  it("does not override an existing token", async () => {
    const base = vi.fn(async (extra: McpExtra) => ({
      userId: extra.authInfo?.token ?? "anon",
      sessionId: "s",
      tags: new Set<string>(),
      isAuthenticated: true,
    })) as unknown as ContextBuilder;

    const wrapped = withFallbackToken(base, "fallback-tok");
    const ctx = await wrapped({ authInfo: { token: "client-tok" } });
    expect(ctx.userId).toBe("client-tok");
  });

  it("returns base builder unchanged when no fallback token configured", async () => {
    const base = vi.fn(async () => ({
      userId: "anon", sessionId: "s", tags: new Set<string>(), isAuthenticated: false,
    })) as unknown as ContextBuilder;

    const wrapped = withFallbackToken(base, undefined);
    expect(wrapped).toBe(base);
  });
});

describe("assertStdioTokenOrExit", () => {
  function makeRepos(opts: { users?: Array<{ status: string }>; skillVisibilities?: string[] }) {
    return {
      userRepo: { findAll: vi.fn(async () => opts.users ?? []) } as never,
      skillRepo: { findAll: vi.fn(async () => (opts.skillVisibilities ?? []).map(visibility => ({ visibility }))) } as never,
    };
  }

  it("passes through when token is provided", async () => {
    const exit = vi.fn() as never;
    const { userRepo, skillRepo } = makeRepos({});
    await assertStdioTokenOrExit("tok", { userRepo, skillRepo, logger: noopLogger, exit });
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits when DB has active users and no token", async () => {
    const exit = vi.fn() as never;
    const { userRepo, skillRepo } = makeRepos({ users: [{ status: "active" }] });
    await assertStdioTokenOrExit(undefined, { userRepo, skillRepo, logger: noopLogger, exit });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits when DB has non-public skills and no token", async () => {
    const exit = vi.fn() as never;
    const { userRepo, skillRepo } = makeRepos({ skillVisibilities: ["private"] });
    await assertStdioTokenOrExit(undefined, { userRepo, skillRepo, logger: noopLogger, exit });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("warns and continues when only public skills exist and no token", async () => {
    const exit = vi.fn() as never;
    const warn = vi.fn();
    const logger = { ...noopLogger, warn } as never;
    const { userRepo, skillRepo } = makeRepos({ skillVisibilities: ["public"] });
    await assertStdioTokenOrExit(undefined, { userRepo, skillRepo, logger, exit });
    expect(exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("warns and continues when DB is empty and no token", async () => {
    const exit = vi.fn() as never;
    const warn = vi.fn();
    const logger = { ...noopLogger, warn } as never;
    const { userRepo, skillRepo } = makeRepos({});
    await assertStdioTokenOrExit(undefined, { userRepo, skillRepo, logger, exit });
    expect(exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("ignores inactive users when checking", async () => {
    const exit = vi.fn() as never;
    const { userRepo, skillRepo } = makeRepos({ users: [{ status: "disabled" }] });
    await assertStdioTokenOrExit(undefined, { userRepo, skillRepo, logger: noopLogger, exit });
    expect(exit).not.toHaveBeenCalled();
  });
});
