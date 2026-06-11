import { describe, it, expect, vi } from "vitest";
import { RemoteJwksProvider, StaticJwksProvider, type Jwk, type JwksDocument } from "@/auth/jwks-provider.js";
import { JwtVerificationError } from "@/utils/errors.js";

function jwk(kid: string): Jwk {
  return { kty: "RSA", kid, n: "n-" + kid, e: "AQAB", alg: "RS256" };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("StaticJwksProvider", () => {
  it("returns the jwk matching kid", async () => {
    const p = new StaticJwksProvider([jwk("a"), jwk("b")]);
    expect((await p.getKey("a")).kid).toBe("a");
    expect((await p.getKey("b")).kid).toBe("b");
  });

  it("falls back to the only key when kid is undefined and there is one key", async () => {
    const p = new StaticJwksProvider([jwk("only")]);
    expect((await p.getKey(undefined)).kid).toBe("only");
  });

  it("throws key_not_found for unknown kid", async () => {
    const p = new StaticJwksProvider([jwk("a")]);
    const err = await p.getKey("missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("key_not_found");
  });
});

describe("RemoteJwksProvider", () => {
  it("fetches and caches keys for the configured TTL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ keys: [jwk("a"), jwk("b")] } satisfies JwksDocument));
    const provider = new RemoteJwksProvider({
      jwksUri: "https://issuer.example.com/jwks",
      ttlMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 0,
    });
    expect((await provider.getKey("a")).kid).toBe("a");
    expect((await provider.getKey("b")).kid).toBe("b");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refreshes once on a kid cache miss to handle key rotation", async () => {
    let fetchCount = 0;
    const fetchImpl = vi.fn(async () => {
      fetchCount += 1;
      if (fetchCount === 1) return jsonResponse({ keys: [jwk("old")] });
      return jsonResponse({ keys: [jwk("old"), jwk("new")] });
    });
    const provider = new RemoteJwksProvider({
      jwksUri: "https://issuer.example.com/jwks",
      ttlMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 0,
    });
    expect((await provider.getKey("old")).kid).toBe("old");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await provider.getKey("new")).kid).toBe("new");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("re-raises key_not_found if the kid is missing after refresh", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ keys: [jwk("a")] }));
    const provider = new RemoteJwksProvider({
      jwksUri: "https://issuer.example.com/jwks",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 0,
    });
    const err = await provider.getKey("z").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("key_not_found");
    expect(fetchImpl).toHaveBeenCalledTimes(2); // initial + refresh on miss
  });

  it("expires the cache after TTL and re-fetches", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => jsonResponse({ keys: [jwk("a")] }));
    const provider = new RemoteJwksProvider({
      jwksUri: "https://issuer.example.com/jwks",
      ttlMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });
    await provider.getKey("a");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 50;
    await provider.getKey("a");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 200;
    await provider.getKey("a");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("raises jwks_fetch_failed on non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500, statusText: "Server Error" }));
    const provider = new RemoteJwksProvider({
      jwksUri: "https://issuer.example.com/jwks",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await provider.getKey("a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("jwks_fetch_failed");
  });

  it("raises jwks_fetch_failed on malformed JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));
    const provider = new RemoteJwksProvider({
      jwksUri: "https://issuer.example.com/jwks",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await provider.getKey("a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("jwks_fetch_failed");
  });

  it("raises jwks_fetch_failed when document is missing keys array", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ wrong: true }));
    const provider = new RemoteJwksProvider({
      jwksUri: "https://issuer.example.com/jwks",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await provider.getKey("a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwtVerificationError);
    expect((err as JwtVerificationError).reason).toBe("jwks_fetch_failed");
  });

  it("deduplicates concurrent refresh calls into a single fetch", async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return jsonResponse({ keys: [jwk("a")] });
    });
    const provider = new RemoteJwksProvider({
      jwksUri: "https://issuer.example.com/jwks",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await Promise.all([provider.getKey("a"), provider.getKey("a"), provider.getKey("a")]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
