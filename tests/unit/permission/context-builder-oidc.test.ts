import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, createSign, createHash, type KeyObject } from "node:crypto";
import {
  buildRequestContext,
  buildRequestContextFromHttp,
  createContextBuilder,
  type OidcContextOptions,
} from "@/permission/context-builder.js";
import type { UserRepository } from "@/db/repositories/user.repository.js";
import type { UserRoleRepository } from "@/db/repositories/user-role.repository.js";
import { OidcVerifier } from "@/auth/oidc-verifier.js";
import { StaticJwksProvider, type Jwk } from "@/auth/jwks-provider.js";

const ISSUER = "https://issuer.example.com";
const AUDIENCE = "skill-mcp-api";

interface KeyMaterial {
  privateKey: KeyObject;
  publicJwk: Jwk;
}

function makeRsaKeypair(kid: string): KeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Jwk;
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, publicJwk: jwk };
}

function b64Url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signJwt(opts: { header: Record<string, unknown>; payload: Record<string, unknown>; privateKey: KeyObject }) {
  const headerSeg = b64Url(JSON.stringify(opts.header));
  const payloadSeg = b64Url(JSON.stringify(opts.payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${headerSeg}.${payloadSeg}`);
  const sig = signer.sign(opts.privateKey);
  return `${headerSeg}.${payloadSeg}.${b64Url(sig)}`;
}

function makeRepos(opts: { user?: { id: string; status: "active" | "disabled"; tenantId?: string } | null; tags?: string[] } = {}) {
  const userRepo = { findByToken: vi.fn(async () => opts.user ?? null) } as unknown as UserRepository;
  const userRoleRepo = {
    getAggregatedTagsByUserId: vi.fn(async () => opts.tags ?? []),
  } as unknown as UserRoleRepository;
  return { userRepo, userRoleRepo };
}

function makeOidc(opts: { allowedAlgorithms?: string[]; userClaim?: string; groupsClaim?: string } = {}): {
  oidc: OidcContextOptions;
  key: KeyMaterial;
  warns: { reason: unknown }[];
} {
  const key = makeRsaKeypair("kid-1");
  const warns: { reason: unknown }[] = [];
  const verifier = new OidcVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: new StaticJwksProvider([key.publicJwk]),
    allowedAlgorithms: opts.allowedAlgorithms,
  });
  return {
    oidc: {
      verifier,
      userClaim: opts.userClaim,
      groupsClaim: opts.groupsClaim,
      logger: { warn: (obj) => warns.push(obj as { reason: unknown }) },
    },
    key,
    warns,
  };
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

describe("context-builder OIDC path (P1-14 stage 2)", () => {
  it("returns authenticated synthetic context for a valid JWT", async () => {
    const { oidc, key } = makeOidc();
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, sub: "alice", exp: nowSec() + 300, groups: ["devs", "admins"] },
      privateKey: key.privateKey,
    });
    const ctx = await buildRequestContext(
      { sessionId: "sess-1", authInfo: { token } },
      userRepo,
      userRoleRepo,
      oidc,
    );
    expect(ctx.isAuthenticated).toBe(true);
    expect(ctx.userId).toBe(`oidc:${ISSUER}:alice`);
    expect(ctx.sessionId).toBe("sess-1");
    expect([...ctx.tags].sort()).toEqual(["admins", "devs"]);
    // OIDC path must not consult the opaque user table.
    expect((userRepo.findByToken as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("falls back to anonymous when JWT verification fails (and warns)", async () => {
    const { oidc, key, warns } = makeOidc();
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    // Wrong audience triggers audience_mismatch.
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: "other-api", sub: "alice", exp: nowSec() + 300 },
      privateKey: key.privateKey,
    });
    const ctx = await buildRequestContext(
      { sessionId: "s", authInfo: { token } },
      userRepo,
      userRoleRepo,
      oidc,
    );
    expect(ctx.isAuthenticated).toBe(false);
    expect(ctx.userId).toBe("anonymous");
    // Failure must NOT fall through to the sha256 opaque-token path.
    expect((userRepo.findByToken as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.reason).toBe("audience_mismatch");
  });

  it("falls back to opaque-token path when token is not JWT-shaped", async () => {
    const { oidc } = makeOidc();
    const { userRepo, userRoleRepo } = makeRepos({
      user: { id: "user-7", status: "active" },
      tags: ["alpha"],
    });
    const ctx = await buildRequestContext(
      { sessionId: "s", authInfo: { token: "opaque-token-no-dots" } },
      userRepo,
      userRoleRepo,
      oidc,
    );
    expect(ctx.isAuthenticated).toBe(true);
    expect(ctx.userId).toBe("user-7");
    expect((userRepo.findByToken as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    const expectedHash = createHash("sha256").update("opaque-token-no-dots").digest("hex");
    expect((userRepo.findByToken as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(expectedHash);
  });

  it("treats tokens with dots but non-base64url chars as opaque", async () => {
    // Payload contains '!' which is not in [A-Za-z0-9_-], so it doesn't match
    // the JWT regex and falls through to the opaque path.
    const { oidc } = makeOidc();
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    await buildRequestContext(
      { sessionId: "s", authInfo: { token: "abc.de!.xyz" } },
      userRepo,
      userRoleRepo,
      oidc,
    );
    expect((userRepo.findByToken as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("treats tokens with two segments as opaque (not enough JWT segments)", async () => {
    const { oidc } = makeOidc();
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    await buildRequestContext(
      { sessionId: "s", authInfo: { token: "abc.def" } },
      userRepo,
      userRoleRepo,
      oidc,
    );
    expect((userRepo.findByToken as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("returns anonymous when verified token lacks the configured user claim", async () => {
    const { oidc, key } = makeOidc();
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      // No `sub` claim at all.
      payload: { iss: ISSUER, aud: AUDIENCE, exp: nowSec() + 300 },
      privateKey: key.privateKey,
    });
    const ctx = await buildRequestContext(
      { sessionId: "s", authInfo: { token } },
      userRepo,
      userRoleRepo,
      oidc,
    );
    expect(ctx.isAuthenticated).toBe(false);
    expect(ctx.userId).toBe("anonymous");
  });

  it("supports a custom user claim", async () => {
    const { oidc, key } = makeOidc({ userClaim: "email" });
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, sub: "ignored", email: "alice@example.com", exp: nowSec() + 300 },
      privateKey: key.privateKey,
    });
    const ctx = await buildRequestContext(
      { sessionId: "s", authInfo: { token } },
      userRepo,
      userRoleRepo,
      oidc,
    );
    expect(ctx.userId).toBe(`oidc:${ISSUER}:alice@example.com`);
  });

  it("supports a custom groups claim and ignores non-string entries", async () => {
    const { oidc, key } = makeOidc({ groupsClaim: "roles" });
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: "alice",
        roles: ["editor", "  ", 42, null, "admin"],
        exp: nowSec() + 300,
      },
      privateKey: key.privateKey,
    });
    const ctx = await buildRequestContext(
      { sessionId: "s", authInfo: { token } },
      userRepo,
      userRoleRepo,
      oidc,
    );
    expect([...ctx.tags].sort()).toEqual(["admin", "editor"]);
  });

  it("returns an empty tag set when groups claim is missing or non-array", async () => {
    const { oidc, key } = makeOidc();
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, sub: "alice", groups: "not-an-array", exp: nowSec() + 300 },
      privateKey: key.privateKey,
    });
    const ctx = await buildRequestContext(
      { sessionId: "s", authInfo: { token } },
      userRepo,
      userRoleRepo,
      oidc,
    );
    expect(ctx.isAuthenticated).toBe(true);
    expect(ctx.tags.size).toBe(0);
  });

  it("buildRequestContextFromHttp threads OIDC opts through", async () => {
    const { oidc, key } = makeOidc();
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, sub: "bob", exp: nowSec() + 300 },
      privateKey: key.privateKey,
    });
    const ctx = await buildRequestContextFromHttp(token, "http-sess", userRepo, userRoleRepo, oidc);
    expect(ctx.isAuthenticated).toBe(true);
    expect(ctx.userId).toBe(`oidc:${ISSUER}:bob`);
    expect(ctx.sessionId).toBe("http-sess");
  });

  it("createContextBuilder closes over OIDC opts", async () => {
    const { oidc, key } = makeOidc();
    const { userRepo, userRoleRepo } = makeRepos({ user: null });
    const builder = createContextBuilder(userRepo, userRoleRepo, oidc);
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, sub: "carol", exp: nowSec() + 300 },
      privateKey: key.privateKey,
    });
    const ctx = await builder({ sessionId: "s", authInfo: { token } });
    expect(ctx.userId).toBe(`oidc:${ISSUER}:carol`);
  });

  it("works without OIDC opts — opaque path is unchanged when SSO is disabled", async () => {
    const { userRepo, userRoleRepo } = makeRepos({
      user: { id: "u", status: "active" },
      tags: [],
    });
    // Even a JWT-shaped token routes to the opaque path when no verifier
    // is configured — back-compat invariant.
    const ctx = await buildRequestContext(
      { sessionId: "s", authInfo: { token: "aaa.bbb.ccc" } },
      userRepo,
      userRoleRepo,
    );
    expect(ctx.isAuthenticated).toBe(true);
    expect(ctx.userId).toBe("u");
  });
});
