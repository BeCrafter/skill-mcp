import { JwtVerificationError } from "../utils/errors.js";

export interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  [extra: string]: unknown;
}

export interface JwksDocument {
  keys: Jwk[];
}

export interface IJwksProvider {
  getKey(kid: string | undefined): Promise<Jwk>;
}

export interface RemoteJwksProviderOptions {
  jwksUri: string;
  ttlMs?: number;
  fetchTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * RemoteJwksProvider fetches a JWKS document over HTTPS, caches the keys for
 * `ttlMs` (default 10min), and refreshes once on a kid cache miss to handle
 * key rotation. A second miss after refresh raises `key_not_found` rather than
 * looping — operators see the failure in audit logs and can investigate.
 */
export class RemoteJwksProvider implements IJwksProvider {
  private cache = new Map<string, Jwk>();
  private cacheExpiresAt = 0;
  private inflight: Promise<void> | null = null;

  private readonly ttlMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: RemoteJwksProviderOptions) {
    this.ttlMs = opts.ttlMs ?? 600_000;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 5_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async getKey(kid: string | undefined): Promise<Jwk> {
    if (this.isExpired()) {
      await this.refresh();
    }
    const cacheKey = kid ?? "__default__";
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    await this.refresh();
    const refreshed = this.cache.get(cacheKey);
    if (!refreshed) {
      throw new JwtVerificationError("key_not_found", `No JWKS key matches kid=${kid ?? "<unspecified>"}`);
    }
    return refreshed;
  }

  private isExpired(): boolean {
    return this.cache.size === 0 || this.now() >= this.cacheExpiresAt;
  }

  private async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.jwksUri, { signal: controller.signal });
    } catch (err) {
      throw new JwtVerificationError(
        "jwks_fetch_failed",
        `Failed to fetch JWKS from ${this.opts.jwksUri}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new JwtVerificationError(
        "jwks_fetch_failed",
        `JWKS endpoint returned ${res.status} ${res.statusText}`,
      );
    }
    let doc: JwksDocument;
    try {
      doc = (await res.json()) as JwksDocument;
    } catch (err) {
      throw new JwtVerificationError(
        "jwks_fetch_failed",
        `JWKS endpoint returned invalid JSON: ${(err as Error).message}`,
      );
    }
    if (!doc || !Array.isArray(doc.keys)) {
      throw new JwtVerificationError("jwks_fetch_failed", "JWKS document missing `keys` array");
    }
    const next = new Map<string, Jwk>();
    for (const jwk of doc.keys) {
      if (!jwk || typeof jwk !== "object") continue;
      if (jwk.kid) next.set(jwk.kid, jwk);
      if (doc.keys.length === 1) next.set("__default__", jwk);
    }
    this.cache = next;
    this.cacheExpiresAt = this.now() + this.ttlMs;
  }
}

/** In-memory provider for single-tenant deployments / tests. */
export class StaticJwksProvider implements IJwksProvider {
  private readonly map: Map<string, Jwk>;
  constructor(keys: Jwk[]) {
    this.map = new Map();
    for (const k of keys) {
      if (k.kid) this.map.set(k.kid, k);
    }
    if (keys.length === 1) this.map.set("__default__", keys[0]!);
  }
  async getKey(kid: string | undefined): Promise<Jwk> {
    const found = this.map.get(kid ?? "__default__");
    if (!found) throw new JwtVerificationError("key_not_found", `No static JWK matches kid=${kid ?? "<unspecified>"}`);
    return found;
  }
}
