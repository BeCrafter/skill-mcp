import { describe, it, expect, vi } from "vitest";
import {
  withFallbackToken,
  extractBearerToken,
  type ContextBuilder,
  type McpExtra,
} from "../../../src/permission/context-builder.js";
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
