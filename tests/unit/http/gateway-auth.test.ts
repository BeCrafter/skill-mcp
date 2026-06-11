import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { enforceGatewayAuth } from "@/http/middleware/gateway-auth.js";
import type { HttpContext } from "@/http/context.js";
import { OidcVerifier } from "@/auth/oidc-verifier.js";
import { StaticJwksProvider, type Jwk } from "@/auth/jwks-provider.js";

const ISSUER = "https://issuer.example.com";
const AUDIENCE = "skill-mcp-api";

function b64Url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function makeRsaKeypair(kid: string): { privateKey: KeyObject; publicJwk: Jwk } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Jwk;
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, publicJwk: jwk };
}

function signJwt(opts: { header: Record<string, unknown>; payload: Record<string, unknown>; privateKey: KeyObject }) {
  const headerSeg = b64Url(JSON.stringify(opts.header));
  const payloadSeg = b64Url(JSON.stringify(opts.payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${headerSeg}.${payloadSeg}`);
  const sig = signer.sign(opts.privateKey);
  return `${headerSeg}.${payloadSeg}.${b64Url(sig)}`;
}

const noopLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;

function makeRes() {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
    statusCode: 0,
  } as never;
}

function makeCtx(authHeader?: string): HttpContext {
  const res = makeRes();
  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
  } as never;
  return {
    req,
    res,
    url: "/api/gateway/skills",
    method: "GET",
    params: {},
    query: new URLSearchParams(),
    logger: noopLogger,
  };
}

function makeRepos(opts: {
  user?: { id: string; status: string } | null;
  tags?: string[];
} = {}) {
  return {
    userRepo: {
      findByToken: vi.fn(async () => opts.user ?? null),
    } as never,
    userRoleRepo: {
      getAggregatedTagsByUserId: vi.fn(async () => opts.tags ?? []),
    } as never,
  };
}

describe("enforceGatewayAuth", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const ctx = makeCtx();
    const { userRepo, userRoleRepo } = makeRepos();
    const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo });
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(401);
  });

  it("returns 401 when Authorization is not Bearer scheme", async () => {
    const ctx = makeCtx("Basic abc");
    const { userRepo, userRoleRepo } = makeRepos();
    const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo });
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(401);
  });

  it("returns 401 when token is unknown", async () => {
    const ctx = makeCtx("Bearer wrong-token");
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo });
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(401);
    const body = (ctx.res.end as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body).toContain("Invalid or expired token");
  });

  it("returns 401 when user is not active", async () => {
    const ctx = makeCtx("Bearer some-token");
    const { userRepo, userRoleRepo } = makeRepos({ user: { id: "u1", status: "disabled" } });
    const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo });
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(401);
  });

  it("returns RequestContext when token resolves to active user", async () => {
    const ctx = makeCtx("Bearer good-token");
    const { userRepo, userRoleRepo } = makeRepos({
      user: { id: "u1", status: "active" },
      tags: ["frontend", "data"],
    });
    const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo });
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("u1");
    expect(result!.isAuthenticated).toBe(true);
    expect([...result!.tags]).toEqual(["frontend", "data"]);
    expect(ctx.res.writeHead).not.toHaveBeenCalled();
  });

  it("returns 500 when userRepo is missing", async () => {
    const ctx = makeCtx("Bearer good-token");
    const result = await enforceGatewayAuth(ctx, {});
    expect(result).toBeNull();
    expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(500);
  });

  it("uses x-session-id header when provided", async () => {
    const ctx = makeCtx("Bearer good-token");
    (ctx.req.headers as Record<string, string>)["x-session-id"] = "session-abc";
    const { userRepo, userRoleRepo } = makeRepos({
      user: { id: "u1", status: "active" },
    });
    const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo });
    expect(result!.sessionId).toBe("session-abc");
  });

  describe("OIDC (P1-14 stage 2)", () => {
    function makeOidc() {
      const { privateKey, publicJwk } = makeRsaKeypair("kid-1");
      const verifier = new OidcVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwks: new StaticJwksProvider([publicJwk]),
      });
      const warns: { reason: unknown }[] = [];
      return {
        privateKey,
        oidc: {
          verifier,
          logger: { warn: (obj: unknown) => warns.push(obj as { reason: unknown }) },
        },
        warns,
      };
    }
    const nowSec = () => Math.floor(Date.now() / 1000);

    it("accepts a valid OIDC JWT, synthesizes context, skips opaque lookup", async () => {
      const { privateKey, oidc } = makeOidc();
      const token = signJwt({
        header: { alg: "RS256", kid: "kid-1" },
        payload: { iss: ISSUER, aud: AUDIENCE, sub: "alice", exp: nowSec() + 300, groups: ["frontend"] },
        privateKey,
      });
      const ctx = makeCtx(`Bearer ${token}`);
      const { userRepo, userRoleRepo } = makeRepos({ user: null });
      const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo, oidc });
      expect(result).not.toBeNull();
      expect(result!.userId).toBe(`oidc:${ISSUER}:alice`);
      expect(result!.isAuthenticated).toBe(true);
      expect([...result!.tags]).toEqual(["frontend"]);
      expect(ctx.res.writeHead).not.toHaveBeenCalled();
      expect((userRepo.findByToken as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it("rejects an OIDC JWT with wrong audience as 401 (no opaque fallthrough)", async () => {
      const { privateKey, oidc, warns } = makeOidc();
      const token = signJwt({
        header: { alg: "RS256", kid: "kid-1" },
        payload: { iss: ISSUER, aud: "other-api", sub: "alice", exp: nowSec() + 300 },
        privateKey,
      });
      const ctx = makeCtx(`Bearer ${token}`);
      const { userRepo, userRoleRepo } = makeRepos({ user: null });
      const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo, oidc });
      expect(result).toBeNull();
      expect((ctx.res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(401);
      expect((userRepo.findByToken as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
      expect(warns[0]?.reason).toBe("audience_mismatch");
    });

    it("non-JWT bearer flows through to opaque path even when oidc opts present", async () => {
      const { oidc } = makeOidc();
      const ctx = makeCtx("Bearer opaque-token-no-dots");
      const { userRepo, userRoleRepo } = makeRepos({
        user: { id: "u-7", status: "active" },
        tags: ["alpha"],
      });
      const result = await enforceGatewayAuth(ctx, { userRepo, userRoleRepo, oidc });
      expect(result).not.toBeNull();
      expect(result!.userId).toBe("u-7");
      expect((userRepo.findByToken as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });
  });
});
