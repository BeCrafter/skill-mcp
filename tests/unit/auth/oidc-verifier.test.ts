import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { OidcVerifier } from "@/auth/oidc-verifier.js";
import { StaticJwksProvider, type Jwk } from "@/auth/jwks-provider.js";
import { JwtVerificationError } from "@/utils/errors.js";

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

function signJwt(opts: {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  privateKey: KeyObject;
  hashAlg?: string;
}): string {
  const headerSeg = b64Url(JSON.stringify(opts.header));
  const payloadSeg = b64Url(JSON.stringify(opts.payload));
  const signer = createSign(opts.hashAlg ?? "RSA-SHA256");
  signer.update(`${headerSeg}.${payloadSeg}`);
  const signature = signer.sign(opts.privateKey);
  return `${headerSeg}.${payloadSeg}.${b64Url(signature)}`;
}

const ISSUER = "https://issuer.example.com";
const AUDIENCE = "skill-mcp-api";

let key1: KeyMaterial;
let key2: KeyMaterial;

beforeAll(() => {
  key1 = makeRsaKeypair("kid-1");
  key2 = makeRsaKeypair("kid-2");
});

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function makeVerifier(opts: {
  jwks?: StaticJwksProvider;
  audience?: string | string[];
  clockSkewSec?: number;
  allowedAlgorithms?: string[];
  now?: () => number;
} = {}) {
  return new OidcVerifier({
    issuer: ISSUER,
    audience: opts.audience ?? AUDIENCE,
    jwks: opts.jwks ?? new StaticJwksProvider([key1.publicJwk]),
    clockSkewSec: opts.clockSkewSec,
    allowedAlgorithms: opts.allowedAlgorithms,
    now: opts.now,
  });
}

describe("OidcVerifier — happy path", () => {
  it("verifies a properly signed RS256 token", async () => {
    const verifier = makeVerifier();
    const now = nowSec();
    const token = signJwt({
      header: { alg: "RS256", typ: "JWT", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, sub: "alice", iat: now, exp: now + 300 },
      privateKey: key1.privateKey,
    });
    const out = await verifier.verify(token);
    expect(out.payload.sub).toBe("alice");
    expect(out.header.alg).toBe("RS256");
  });

  it("accepts aud as a string-in-array claim", async () => {
    const verifier = makeVerifier();
    const now = nowSec();
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: [AUDIENCE, "other"], sub: "alice", exp: now + 300 },
      privateKey: key1.privateKey,
    });
    const out = await verifier.verify(token);
    expect(out.payload.sub).toBe("alice");
  });

  it("accepts a configured audience allow-list", async () => {
    const verifier = makeVerifier({ audience: ["api-a", "api-b"] });
    const now = nowSec();
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: "api-b", sub: "alice", exp: now + 300 },
      privateKey: key1.privateKey,
    });
    await expect(verifier.verify(token)).resolves.toBeDefined();
  });
});

describe("OidcVerifier — failure modes", () => {
  it("rejects malformed tokens (wrong segment count)", async () => {
    const verifier = makeVerifier();
    const err = await verifier.verify("a.b").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("malformed");
  });

  it("rejects tokens with non-base64url segments", async () => {
    const verifier = makeVerifier();
    const err = await verifier.verify("@@@.@@@.@@@").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("malformed");
  });

  it("rejects unsupported algorithms", async () => {
    const verifier = makeVerifier();
    const now = nowSec();
    const token = signJwt({
      header: { alg: "HS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, exp: now + 300 },
      privateKey: key1.privateKey,
    });
    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("unsupported_algorithm");
  });

  it("rejects alg=none", async () => {
    const verifier = makeVerifier();
    const now = nowSec();
    const headerSeg = b64Url(JSON.stringify({ alg: "none", kid: "kid-1" }));
    const payloadSeg = b64Url(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, exp: now + 300 }));
    const token = `${headerSeg}.${payloadSeg}.`;
    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("unsupported_algorithm");
  });

  it("rejects when kid does not exist in JWKS", async () => {
    const verifier = makeVerifier();
    const now = nowSec();
    const token = signJwt({
      header: { alg: "RS256", kid: "missing-kid" },
      payload: { iss: ISSUER, aud: AUDIENCE, exp: now + 300 },
      privateKey: key1.privateKey,
    });
    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("key_not_found");
  });

  it("rejects when signature was created with a different key", async () => {
    const verifier = makeVerifier({ jwks: new StaticJwksProvider([key1.publicJwk]) });
    const now = nowSec();
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, exp: now + 300 },
      privateKey: key2.privateKey,
    });
    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("invalid_signature");
  });

  it("rejects tampered payload (signature recomputed mismatch)", async () => {
    const verifier = makeVerifier();
    const now = nowSec();
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, exp: now + 300 },
      privateKey: key1.privateKey,
    });
    const [h, _p, s] = token.split(".");
    const tampered = [h, b64Url(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, exp: now + 300, role: "admin" })), s].join(".");
    const err = await verifier.verify(tampered).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("invalid_signature");
  });

  it("rejects mismatched issuer", async () => {
    const verifier = makeVerifier();
    const now = nowSec();
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: "https://attacker.example.com", aud: AUDIENCE, exp: now + 300 },
      privateKey: key1.privateKey,
    });
    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("issuer_mismatch");
  });

  it("rejects mismatched audience", async () => {
    const verifier = makeVerifier();
    const now = nowSec();
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: "wrong-aud", exp: now + 300 },
      privateKey: key1.privateKey,
    });
    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("audience_mismatch");
  });

  it("rejects expired tokens (beyond clock skew)", async () => {
    const verifier = makeVerifier({ clockSkewSec: 30, now: () => 100_000 });
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, exp: 99_960 }, // 40s ago, > skew of 30
      privateKey: key1.privateKey,
    });
    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("expired");
  });

  it("accepts tokens within the configured clock skew", async () => {
    const verifier = makeVerifier({ clockSkewSec: 60, now: () => 100_000 });
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, exp: 99_980 }, // 20s ago, within skew
      privateKey: key1.privateKey,
    });
    await expect(verifier.verify(token)).resolves.toBeDefined();
  });

  it("rejects tokens whose nbf is in the future (beyond clock skew)", async () => {
    const verifier = makeVerifier({ clockSkewSec: 30, now: () => 100_000 });
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, nbf: 100_500, exp: 200_000 },
      privateKey: key1.privateKey,
    });
    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("not_yet_valid");
  });

  it("does not require exp/nbf claims (provider may omit)", async () => {
    const verifier = makeVerifier();
    const token = signJwt({
      header: { alg: "RS256", kid: "kid-1" },
      payload: { iss: ISSUER, aud: AUDIENCE, sub: "no-times" },
      privateKey: key1.privateKey,
    });
    await expect(verifier.verify(token)).resolves.toBeDefined();
  });

  it("supports custom allowedAlgorithms list (RS512)", async () => {
    const verifier = makeVerifier({ allowedAlgorithms: ["RS512"] });
    const now = nowSec();
    const headerSeg = b64Url(JSON.stringify({ alg: "RS512", kid: "kid-1" }));
    const payloadSeg = b64Url(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, exp: now + 300 }));
    const signer = createSign("RSA-SHA512");
    signer.update(`${headerSeg}.${payloadSeg}`);
    const sig = signer.sign(key1.privateKey);
    const token = `${headerSeg}.${payloadSeg}.${b64Url(sig)}`;
    await expect(verifier.verify(token)).resolves.toBeDefined();
  });
});
