import { createPublicKey, verify as cryptoVerify, type KeyObject, type JsonWebKey } from "node:crypto";
import { JwtVerificationError } from "../utils/errors.js";
import type { IJwksProvider, Jwk } from "./jwks-provider.js";

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
  [extra: string]: unknown;
}

export interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [claim: string]: unknown;
}

export interface VerifiedJwt {
  header: JwtHeader;
  payload: JwtPayload;
  signature: Buffer;
  raw: { header: string; payload: string; signature: string };
}

export interface OidcVerifierConfig {
  issuer: string;
  audience: string | string[];
  jwks: IJwksProvider;
  /** Allowed `alg` values; defaults to RS256 only. */
  allowedAlgorithms?: string[];
  /** Allowed clock skew in seconds when checking exp/nbf (default 60). */
  clockSkewSec?: number;
  /** Override clock for tests. */
  now?: () => number;
}

const RS_TO_HASH: Record<string, string> = {
  RS256: "RSA-SHA256",
  RS384: "RSA-SHA384",
  RS512: "RSA-SHA512",
};

const DEFAULT_ALLOWED_ALGS = ["RS256"];

/**
 * P1-14 stage 1 — pure crypto-level OIDC JWT verifier. No auth wiring; the
 * stage-2 middleware will wrap this. Supports RS{256,384,512} signatures via
 * Node 22's built-in `crypto` (no `jose` / `jsonwebtoken` deps). HS* / `none`
 * are explicitly rejected — they don't fit the OIDC trust model and would
 * weaken the surface.
 */
export class OidcVerifier {
  private readonly allowedAlgorithms: Set<string>;
  private readonly clockSkewSec: number;
  private readonly now: () => number;

  constructor(private readonly config: OidcVerifierConfig) {
    this.allowedAlgorithms = new Set(config.allowedAlgorithms ?? DEFAULT_ALLOWED_ALGS);
    this.clockSkewSec = config.clockSkewSec ?? 60;
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async verify(token: string): Promise<VerifiedJwt> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new JwtVerificationError("malformed", "JWT must have 3 dot-separated segments");
    }
    const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

    let header: JwtHeader;
    let payload: JwtPayload;
    let signature: Buffer;
    try {
      header = JSON.parse(b64UrlDecode(rawHeader).toString("utf8")) as JwtHeader;
      payload = JSON.parse(b64UrlDecode(rawPayload).toString("utf8")) as JwtPayload;
      signature = b64UrlDecode(rawSignature);
    } catch (err) {
      throw new JwtVerificationError("malformed", `Failed to decode JWT: ${(err as Error).message}`);
    }

    if (!header || typeof header.alg !== "string") {
      throw new JwtVerificationError("malformed", "JWT header missing `alg`");
    }
    if (!this.allowedAlgorithms.has(header.alg)) {
      throw new JwtVerificationError("unsupported_algorithm", `Algorithm ${header.alg} is not allowed`);
    }
    const hashAlg = RS_TO_HASH[header.alg];
    if (!hashAlg) {
      throw new JwtVerificationError("unsupported_algorithm", `Algorithm ${header.alg} is not implemented`);
    }

    const jwk = await this.config.jwks.getKey(header.kid);
    const key = jwkToKeyObject(jwk);

    const signedData = Buffer.from(`${rawHeader}.${rawPayload}`, "utf8");
    const ok = cryptoVerify(hashAlg, signedData, key, signature);
    if (!ok) {
      throw new JwtVerificationError("invalid_signature", "JWT signature did not match the JWKS key");
    }

    if (payload.iss !== this.config.issuer) {
      throw new JwtVerificationError(
        "issuer_mismatch",
        `Expected iss=${this.config.issuer}, got ${String(payload.iss)}`,
      );
    }

    const expectedAuds = Array.isArray(this.config.audience) ? this.config.audience : [this.config.audience];
    const tokenAuds = payload.aud === undefined ? [] : Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const audMatch = tokenAuds.some((a) => expectedAuds.includes(a));
    if (!audMatch) {
      throw new JwtVerificationError(
        "audience_mismatch",
        `Token aud=${JSON.stringify(payload.aud)} did not match expected ${JSON.stringify(this.config.audience)}`,
      );
    }

    const now = this.now();
    if (typeof payload.exp === "number" && now > payload.exp + this.clockSkewSec) {
      throw new JwtVerificationError("expired", `Token expired at ${payload.exp} (now ${now})`);
    }
    if (typeof payload.nbf === "number" && now + this.clockSkewSec < payload.nbf) {
      throw new JwtVerificationError("not_yet_valid", `Token not valid before ${payload.nbf} (now ${now})`);
    }

    return {
      header,
      payload,
      signature,
      raw: { header: rawHeader, payload: rawPayload, signature: rawSignature },
    };
  }
}

function jwkToKeyObject(jwk: Jwk): KeyObject {
  try {
    return createPublicKey({ format: "jwk", key: jwk as unknown as JsonWebKey });
  } catch (err) {
    throw new JwtVerificationError("invalid_signature", `JWK could not be loaded: ${(err as Error).message}`);
  }
}

function b64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const std = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(std, "base64");
}

export const __test__ = { b64UrlDecode };
