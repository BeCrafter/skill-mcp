import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import {
  buildRequestContext,
  type OidcContextOptions,
} from "@/permission/context-builder.js";
import type { UserRepository } from "@/db/repositories/user.repository.js";
import type { UserRoleRepository } from "@/db/repositories/user-role.repository.js";
import { OidcVerifier } from "@/auth/oidc-verifier.js";
import { StaticJwksProvider, type Jwk } from "@/auth/jwks-provider.js";
import type { OidcProvisioner, OidcProvisionResult } from "@/auth/oidc-provisioner.js";

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

function makeRepos() {
  const userRepo = { findByToken: vi.fn(async () => null) } as unknown as UserRepository;
  const userRoleRepo = {
    getAggregatedTagsByUserId: vi.fn(async () => [] as string[]),
  } as unknown as UserRoleRepository;
  return { userRepo, userRoleRepo };
}

function makeOidcWithProvisioner(provisionResult: OidcProvisionResult | null | Error): {
  oidc: OidcContextOptions;
  key: KeyMaterial;
  provisionerCalls: number;
} {
  const key = makeRsaKeypair("kid-1");
  let provisionerCalls = 0;
  const provisioner = {
    provisionFromJwt: vi.fn(async () => {
      provisionerCalls++;
      if (provisionResult instanceof Error) throw provisionResult;
      return provisionResult;
    }),
  } as unknown as OidcProvisioner;
  const verifier = new OidcVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: new StaticJwksProvider([key.publicJwk]),
  });
  return {
    oidc: {
      verifier,
      provisioner,
      logger: { warn: () => {} },
    },
    key,
    get provisionerCalls() { return provisionerCalls; },
  };
}

function nowSec() { return Math.floor(Date.now() / 1000); }

describe("context-builder OIDC + provisioner (P1-14 stage 3)", () => {
  it("uses real userId returned by the provisioner instead of synthetic oidc:<iss>:<sub>", async () => {
    const handle = makeOidcWithProvisioner({
      userId: "user-real-uuid-1",
      tenantId: "default",
      tags: ["fe", "js"],
      isNewUser: true,
    });
    const { userRepo, userRoleRepo } = makeRepos();
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, sub: "alice", exp: nowSec() + 300, groups: ["engineering"] },
      privateKey: handle.key.privateKey,
    });
    const ctx = await buildRequestContext(
      { sessionId: "sess-1", authInfo: { token } },
      userRepo,
      userRoleRepo,
      handle.oidc,
    );
    expect(ctx.userId).toBe("user-real-uuid-1");
    expect(ctx.tenantId).toBe("default");
    expect(ctx.isAuthenticated).toBe(true);
    // Tags should be the union of provisioner tags and group-claim tags.
    expect([...ctx.tags].sort()).toEqual(["engineering", "fe", "js"]);
    expect(handle.provisionerCalls).toBe(1);
  });

  it("falls back to synthetic context when provisioner returns null", async () => {
    const handle = makeOidcWithProvisioner(null);
    const { userRepo, userRoleRepo } = makeRepos();
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, sub: "alice", exp: nowSec() + 300, groups: ["devs"] },
      privateKey: handle.key.privateKey,
    });
    const ctx = await buildRequestContext(
      { sessionId: "sess-2", authInfo: { token } },
      userRepo,
      userRoleRepo,
      handle.oidc,
    );
    expect(ctx.userId).toBe(`oidc:${ISSUER}:alice`);
    expect([...ctx.tags]).toEqual(["devs"]);
  });

  it("falls back to synthetic context when provisioner throws", async () => {
    const handle = makeOidcWithProvisioner(new Error("DB down"));
    const { userRepo, userRoleRepo } = makeRepos();
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, sub: "alice", exp: nowSec() + 300, groups: ["devs"] },
      privateKey: handle.key.privateKey,
    });
    const ctx = await buildRequestContext(
      { sessionId: "sess-3", authInfo: { token } },
      userRepo,
      userRoleRepo,
      handle.oidc,
    );
    // Cryptographically-valid token still authenticates with synthetic id.
    expect(ctx.isAuthenticated).toBe(true);
    expect(ctx.userId).toBe(`oidc:${ISSUER}:alice`);
  });

  it("merges duplicate tags from provisioner + group claim", async () => {
    const handle = makeOidcWithProvisioner({
      userId: "u1",
      tenantId: "default",
      tags: ["engineering", "extra"],
      isNewUser: false,
    });
    const { userRepo, userRoleRepo } = makeRepos();
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, sub: "alice", exp: nowSec() + 300, groups: ["engineering", "ops"] },
      privateKey: handle.key.privateKey,
    });
    const ctx = await buildRequestContext(
      { sessionId: "s", authInfo: { token } },
      userRepo,
      userRoleRepo,
      handle.oidc,
    );
    expect([...ctx.tags].sort()).toEqual(["engineering", "extra", "ops"]);
  });

  it("propagates tenantId from the provisioner", async () => {
    const handle = makeOidcWithProvisioner({
      userId: "u1",
      tenantId: "tenant-acme",
      tags: [],
      isNewUser: true,
    });
    const { userRepo, userRoleRepo } = makeRepos();
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, sub: "alice", exp: nowSec() + 300 },
      privateKey: handle.key.privateKey,
    });
    const ctx = await buildRequestContext(
      { sessionId: "s", authInfo: { token } },
      userRepo,
      userRoleRepo,
      handle.oidc,
    );
    expect(ctx.tenantId).toBe("tenant-acme");
  });
});
