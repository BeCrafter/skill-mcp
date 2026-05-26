import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompositeCacheProvider } from "../../../src/cache/composite.provider.js";
import type { ICacheProvider } from "../../../src/cache/provider.interface.js";
import { metrics, registry } from "../../../src/telemetry/metrics.js";

interface PrivateLayers {
  l1: ICacheProvider;
  l2: ICacheProvider;
  l2TtlMultiplier: number;
}

function layers(c: CompositeCacheProvider): PrivateLayers {
  return c as unknown as PrivateLayers;
}

describe("CompositeCacheProvider", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "skill-mcp-composite-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("L1 hit short-circuits and does not consult L2", async () => {
    const c = new CompositeCacheProvider({
      memory: { enabled: true, maxSize: 10 },
      file: { enabled: true, cacheDir },
    });
    await c.set("k", "v1", 60);
    // Mutate L2 directly to a different value; L1 hit should win.
    await layers(c).l2.set("k", "v2-from-l2", 60);

    expect(await c.get("k")).toBe("v1");
  });

  it("set stores L2 with ttl * multiplier", async () => {
    const c = new CompositeCacheProvider({
      memory: { enabled: true, maxSize: 10 },
      file: { enabled: true, cacheDir },
      l2TtlMultiplier: 3,
    });
    const before = Date.now();
    await c.set("k", "v", 10);

    const l1Meta = await layers(c).l1.getWithMeta<string>("k");
    const l2Meta = await layers(c).l2.getWithMeta<string>("k");
    expect(l1Meta?.value).toBe("v");
    expect(l2Meta?.value).toBe("v");

    // L1 ≈ now + 10s; L2 ≈ now + 30s. Allow generous slack for slow CI.
    expect(l1Meta!.expiresAt!).toBeGreaterThan(before + 5_000);
    expect(l1Meta!.expiresAt!).toBeLessThan(before + 15_000);
    expect(l2Meta!.expiresAt!).toBeGreaterThan(before + 25_000);
    expect(l2Meta!.expiresAt!).toBeLessThan(before + 35_000);
  });

  it("L1 miss + L2 hit promotes value to L1 with remaining L2 TTL", async () => {
    const c = new CompositeCacheProvider({
      memory: { enabled: true, maxSize: 10 },
      file: { enabled: true, cacheDir },
      l2TtlMultiplier: 4,
    });
    await c.set("k", "v", 10); // L1 ttl 10s, L2 ttl 40s
    await layers(c).l1.delete("k");

    const meta = await c.getWithMeta<string>("k");
    expect(meta?.value).toBe("v");

    // After promotion, L1 should now be populated with the L2 remainingTTL,
    // i.e. close to 40s — well above the original 10s L1 ttl.
    const l1After = await layers(c).l1.getWithMeta<string>("k");
    expect(l1After).not.toBeNull();
    const remainingMs = l1After!.expiresAt! - Date.now();
    expect(remainingMs).toBeGreaterThan(20_000);
    expect(remainingMs).toBeLessThan(45_000);
  });

  it("set without ttl stores in both layers without expiry", async () => {
    const c = new CompositeCacheProvider({
      memory: { enabled: true, maxSize: 10 },
      file: { enabled: true, cacheDir },
    });
    await c.set("k", "v");
    const l1Meta = await layers(c).l1.getWithMeta<string>("k");
    const l2Meta = await layers(c).l2.getWithMeta<string>("k");
    expect(l1Meta?.expiresAt).toBeNull();
    expect(l2Meta?.expiresAt).toBeNull();
  });

  it("delete propagates to both layers", async () => {
    const c = new CompositeCacheProvider({
      memory: { enabled: true, maxSize: 10 },
      file: { enabled: true, cacheDir },
    });
    await c.set("k", "v", 60);
    await c.delete("k");
    expect(await layers(c).l1.get("k")).toBeNull();
    expect(await layers(c).l2.get("k")).toBeNull();
  });

  it("clearByPrefix propagates to both layers", async () => {
    const c = new CompositeCacheProvider({
      memory: { enabled: true, maxSize: 10 },
      file: { enabled: true, cacheDir },
    });
    await c.set("skill:a", "1", 60);
    await c.set("skill:b", "2", 60);
    await c.set("other:c", "3", 60);

    await c.clearByPrefix("skill:");
    expect(await c.get("skill:a")).toBeNull();
    expect(await c.get("skill:b")).toBeNull();
    expect(await c.get("other:c")).toBe("3");
  });

  it("disabled L1 (NoopCacheProvider) routes reads/writes to L2 only", async () => {
    const c = new CompositeCacheProvider({
      memory: { enabled: false, maxSize: 10 },
      file: { enabled: true, cacheDir },
    });
    await c.set("k", "v", 60);
    expect(await c.get("k")).toBe("v");
    expect(await layers(c).l1.get("k")).toBeNull();
  });

  it("disabled L2 (NoopCacheProvider) keeps data only in L1", async () => {
    const c = new CompositeCacheProvider({
      memory: { enabled: true, maxSize: 10 },
      file: { enabled: false, cacheDir },
    });
    await c.set("k", "v", 60);
    expect(await c.get("k")).toBe("v");
    expect(await layers(c).l2.get("k")).toBeNull();
  });

  it("both layers disabled returns null on all gets (Noop+Noop)", async () => {
    const c = new CompositeCacheProvider({
      memory: { enabled: false, maxSize: 10 },
      file: { enabled: false, cacheDir },
    });
    await c.set("k", "v", 60);
    expect(await c.get("k")).toBeNull();
    expect(await c.has("k")).toBe(false);
  });

  it("has() reflects underlying state", async () => {
    const c = new CompositeCacheProvider({
      memory: { enabled: true, maxSize: 10 },
      file: { enabled: true, cacheDir },
    });
    expect(await c.has("k")).toBe(false);
    await c.set("k", "v", 60);
    expect(await c.has("k")).toBe(true);
  });

  it("cacheOps counter records L1 hit/miss and L2 hit/miss separately", async () => {
    metrics.cacheOps.reset();
    const c = new CompositeCacheProvider({
      memory: { enabled: true, maxSize: 10 },
      file: { enabled: true, cacheDir },
    });

    // Miss both layers (L1 miss + L2 miss).
    expect(await c.get("absent")).toBeNull();

    // Seed L2 only and read — L1 miss + L2 hit (also promotes to L1).
    await layers(c).l2.set("only-l2", "v", 60);
    expect(await c.get("only-l2")).toBe("v");

    // Read again — should now be L1 hit.
    expect(await c.get("only-l2")).toBe("v");

    const text = await registry.metrics();
    const cacheLines = text.split("\n").filter(l => l.startsWith("skill_mcp_cache_operations_total"));
    const joined = cacheLines.join("\n");
    expect(joined).toMatch(/layer="l1",result="hit".*\b1\b/);
    expect(joined).toMatch(/layer="l1",result="miss".*\b2\b/);
    expect(joined).toMatch(/layer="l2",result="hit".*\b1\b/);
    expect(joined).toMatch(/layer="l2",result="miss".*\b1\b/);
  });
});
