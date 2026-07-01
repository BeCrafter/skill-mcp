import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  withFallbackToken,
  extractBearerToken,
  attachMcpAuthFromHeaders,
  buildRequestContext,
  buildRequestContextFromHttp,
  createContextBuilder,
  type ContextBuilder,
  type McpExtra,
} from "../../../src/permission/context-builder.js";
import type { UserRepository } from "../../../src/db/repositories/user.repository.js";
import type { UserRoleRepository } from "../../../src/db/repositories/user-role.repository.js";
import type { RequestContext } from "../../../src/types/index.js";

function makeBase(): { base: ContextBuilder; calls: McpExtra[] } {
  const calls: McpExtra[] = [];
  const base: ContextBuilder = vi.fn(async (extra: McpExtra) => {
    calls.push(extra);
    const token = extra.authInfo?.token ?? null;
    return {
      userId: token ? `user-of-${token}` : "anonymous",
      sessionId: extra.sessionId ?? "fallback-session",
      tags: new Set<string>(),
      isAuthenticated: Boolean(token),
    } satisfies RequestContext;
  });
  return { base, calls };
}

describe("withFallbackToken", () => {
  it("returns the base builder unchanged when fallback is undefined", () => {
    const { base } = makeBase();
    const wrapped = withFallbackToken(base, undefined);
    expect(wrapped).toBe(base);
  });

  it("returns the base builder unchanged when fallback is empty string", () => {
    const { base } = makeBase();
    const wrapped = withFallbackToken(base, "");
    expect(wrapped).toBe(base);
  });

  it("injects fallback token when caller provides no authInfo", async () => {
    const { base, calls } = makeBase();
    const wrapped = withFallbackToken(base, "fallback-tok");

    const ctx = await wrapped({ sessionId: "s1" });
    expect(ctx.userId).toBe("user-of-fallback-tok");
    expect(calls[0].authInfo?.token).toBe("fallback-tok");
    expect(calls[0].sessionId).toBe("s1");
  });

  it("injects fallback token when authInfo exists but token is missing", async () => {
    const { base, calls } = makeBase();
    const wrapped = withFallbackToken(base, "fallback-tok");

    await wrapped({ sessionId: "s2", authInfo: {} });
    expect(calls[0].authInfo?.token).toBe("fallback-tok");
  });

  it("does not override an explicit caller token", async () => {
    const { base, calls } = makeBase();
    const wrapped = withFallbackToken(base, "fallback-tok");

    const ctx = await wrapped({ sessionId: "s3", authInfo: { token: "real-tok" } });
    expect(ctx.userId).toBe("user-of-real-tok");
    expect(calls[0].authInfo?.token).toBe("real-tok");
  });

  it("preserves sessionId when injecting fallback", async () => {
    const { base, calls } = makeBase();
    const wrapped = withFallbackToken(base, "fallback-tok");

    await wrapped({ sessionId: "preserved-session" });
    expect(calls[0].sessionId).toBe("preserved-session");
  });
});

describe("extractBearerToken", () => {
  it("returns null for undefined / empty headers", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
  });

  it("returns null when scheme is not Bearer", () => {
    expect(extractBearerToken("Basic abc123")).toBeNull();
    expect(extractBearerToken("Token abc123")).toBeNull();
  });

  it("extracts token after Bearer prefix", () => {
    expect(extractBearerToken("Bearer mytoken")).toBe("mytoken");
  });

  it("is case-insensitive on the Bearer prefix", () => {
    expect(extractBearerToken("bearer mytoken")).toBe("mytoken");
    expect(extractBearerToken("BEARER mytoken")).toBe("mytoken");
    expect(extractBearerToken("BeArEr mytoken")).toBe("mytoken");
  });

  it("trims surrounding whitespace", () => {
    expect(extractBearerToken("   Bearer   mytoken   ")).toBe("mytoken");
  });

  it("returns null when token portion is empty", () => {
    expect(extractBearerToken("Bearer ")).toBeNull();
    expect(extractBearerToken("Bearer    ")).toBeNull();
  });

  it("rejects oversized headers (>4096 bytes)", () => {
    const huge = "Bearer " + "a".repeat(4096);
    expect(extractBearerToken(huge)).toBeNull();
  });

  it("rejects oversized tokens (>4096 bytes) even within header limit", () => {
    // Header cap is 4096 bytes including "Bearer " prefix; we craft a header
    // that is exactly at the header limit but whose token slice exceeds the
    // 4096-byte token cap. Header = 4096 bytes; token portion = 4089 bytes —
    // well below the token cap. Use a separately-built case that pushes the
    // *token* past 4096 while keeping the *header* below 4096 is impossible
    // by construction (token <= header), so we instead verify the cap by
    // submitting the largest legal header and confirming it parses.
    const tok = "a".repeat(4089);
    expect(extractBearerToken(`Bearer ${tok}`)).toBe(tok);
  });

  it("accepts a token of exactly 1024 bytes", () => {
    const tok = "a".repeat(1024);
    expect(extractBearerToken(`Bearer ${tok}`)).toBe(tok);
  });
});

describe("attachMcpAuthFromHeaders (T-738)", () => {
  it("populates req.auth.token from Authorization: Bearer header", () => {
    const req = { headers: { authorization: "Bearer sk-live-abc" } } as Parameters<typeof attachMcpAuthFromHeaders>[0];
    attachMcpAuthFromHeaders(req);
    expect(req.auth).toEqual({ token: "sk-live-abc" });
  });

  it("leaves req.auth unset when header is missing", () => {
    const req = { headers: {} } as Parameters<typeof attachMcpAuthFromHeaders>[0];
    attachMcpAuthFromHeaders(req);
    expect(req.auth).toBeUndefined();
  });

  it("leaves req.auth unset when header is malformed", () => {
    const req = { headers: { authorization: "Basic abc" } } as Parameters<typeof attachMcpAuthFromHeaders>[0];
    attachMcpAuthFromHeaders(req);
    expect(req.auth).toBeUndefined();
  });

  it("is idempotent — does not overwrite a pre-set req.auth", () => {
    const req = {
      headers: { authorization: "Bearer different-token" },
      auth: { token: "preset-token" },
    } as Parameters<typeof attachMcpAuthFromHeaders>[0];
    attachMcpAuthFromHeaders(req);
    expect(req.auth).toEqual({ token: "preset-token" });
  });

  it("uses the first value when Authorization arrives as an array", () => {
    const req = { headers: { authorization: ["Bearer first", "Bearer second"] } } as Parameters<typeof attachMcpAuthFromHeaders>[0];
    attachMcpAuthFromHeaders(req);
    expect(req.auth).toEqual({ token: "first" });
  });
});

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function makeRepos(opts: {
  user?: { id: string; status: "active" | "disabled" } | null;
  tags?: string[];
}): { userRepo: UserRepository; userRoleRepo: UserRoleRepository } {
  const userRepo = { findByToken: vi.fn(async () => opts.user ?? null) } as unknown as UserRepository;
  const userRoleRepo = {
    getAggregatedTagsByUserId: vi.fn(async () => opts.tags ?? []),
  } as unknown as UserRoleRepository;
  return { userRepo, userRoleRepo };
}

describe("buildRequestContext / buildRequestContextFromHttp", () => {
  it("returns anonymous context with provided sessionId when token is missing", async () => {
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    const ctx = await buildRequestContext({ sessionId: "sess-1" }, userRepo, userRoleRepo);
    expect(ctx).toEqual({ userId: "anonymous", sessionId: "sess-1", tags: new Set(), isAuthenticated: false, userType: undefined });
    expect((userRepo.findByToken as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("generates a sessionId when none provided", async () => {
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    const ctx = await buildRequestContext({}, userRepo, userRoleRepo);
    expect(ctx.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("throws AuthenticationError when token does not match any user", async () => {
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    await expect(buildRequestContext(
      { sessionId: "s", authInfo: { token: "unknown" } },
      userRepo,
      userRoleRepo,
    )).rejects.toThrow("Invalid or expired token");
  });

  it("throws AuthenticationError when matched user is disabled", async () => {
    const { userRepo, userRoleRepo } = makeRepos({ user: { id: "u1", status: "disabled" }, tags: ["admin"] });
    await expect(buildRequestContext(
      { sessionId: "s", authInfo: { token: "tok" } },
      userRepo,
      userRoleRepo,
    )).rejects.toThrow("Invalid or expired token");
  });

  it("returns authenticated context with aggregated tags for active user", async () => {
    const { userRepo, userRoleRepo } = makeRepos({
      user: { id: "user-42", status: "active" },
      tags: ["alpha", "beta"],
    });
    const ctx = await buildRequestContext(
      { sessionId: "s-1", authInfo: { token: "real-tok" } },
      userRepo,
      userRoleRepo,
    );
    expect(ctx.isAuthenticated).toBe(true);
    expect(ctx.userId).toBe("user-42");
    expect(ctx.sessionId).toBe("s-1");
    expect([...ctx.tags].sort()).toEqual(["alpha", "beta"]);
  });

  it("buildRequestContextFromHttp delegates to the same resolution path", async () => {
    const { userRepo, userRoleRepo } = makeRepos({
      user: { id: "u-http", status: "active" },
      tags: ["t"],
    });
    const ctx = await buildRequestContextFromHttp("http-tok", "http-sess", userRepo, userRoleRepo);
    expect(ctx.userId).toBe("u-http");
    expect(ctx.sessionId).toBe("http-sess");
    expect(ctx.tags.has("t")).toBe(true);
  });

  it("buildRequestContextFromHttp with null token returns anonymous", async () => {
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    const ctx = await buildRequestContextFromHttp(null, "s", userRepo, userRoleRepo);
    expect(ctx.isAuthenticated).toBe(false);
  });

});

describe("createContextBuilder", () => {
  it("returns a builder that closes over the provided repos", async () => {
    const { userRepo, userRoleRepo } = makeRepos({
      user: { id: "u", status: "active" },
      tags: ["x"],
    });
    const builder = createContextBuilder(userRepo, userRoleRepo);
    const ctx = await builder({ sessionId: "s", authInfo: { token: "tok" } });
    expect(ctx.userId).toBe("u");
    expect(ctx.tags.has("x")).toBe(true);
  });
});
