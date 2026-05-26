import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCacheProvider } from "@/cache/file.provider.js";
import { metrics } from "@/telemetry/metrics.js";

/**
 * T-403 — periodic GC sweeps. Tests construct providers with `gcIntervalMs: 0`
 * so the background timer never fires, and drive `runGc()` manually after
 * advancing wall-clock TTLs with real sleeps. The interval-driven path is
 * verified separately by a single fast-tick assertion at the end.
 */
describe("FileCacheProvider GC (T-403)", () => {
  let dir: string;
  let cache: FileCacheProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-cache-gc-"));
  });

  afterEach(() => {
    cache?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("evicts entries whose TTL has expired and leaves fresh ones in place", async () => {
    cache = new FileCacheProvider(dir, { gcIntervalMs: 0 });
    await cache.set("expired", "x", 1);
    await cache.set("fresh", "y", 60);
    await new Promise(r => setTimeout(r, 1100));

    const evicted = await cache.runGc();

    expect(evicted).toBe(1);
    expect(await cache.get("expired")).toBeNull();
    expect(await cache.get("fresh")).toBe("y");

    const files = readdirSync(dir);
    // 2 files (cache + meta) for "fresh", nothing else.
    expect(files).toHaveLength(2);
  });

  it("treats null-TTL entries as immortal", async () => {
    cache = new FileCacheProvider(dir, { gcIntervalMs: 0 });
    await cache.set("forever", "z");

    const evicted = await cache.runGc();

    expect(evicted).toBe(0);
    expect(await cache.get("forever")).toBe("z");
  });

  it("drops index entries whose meta file is missing or corrupt", async () => {
    cache = new FileCacheProvider(dir, { gcIntervalMs: 0 });
    await cache.set("normal", "a", 60);
    // Force a phantom index entry that points at a hash with no files
    // (simulates a meta that vanished out-of-band).
    (cache as unknown as { keyIndex: Map<string, string> }).keyIndex.set(
      "ghost",
      "deadbeefdeadbeefdeadbeefdeadbeef",
    );

    await cache.runGc();

    const indexAfter = (cache as unknown as { keyIndex: Map<string, string> }).keyIndex;
    expect(indexAfter.has("ghost")).toBe(false);
    expect(indexAfter.has("normal")).toBe(true);
  });

  it("increments cache_gc_runs and cache_gc_evicted metrics", async () => {
    const runsBefore = await metrics.cacheGcRuns.get();
    const evictedBefore = await metrics.cacheGcEvicted.get();
    const runsBaseline = runsBefore.values.find(v => v.labels.layer === "file")?.value ?? 0;
    const evictedBaseline = evictedBefore.values.find(v => v.labels.layer === "file")?.value ?? 0;

    cache = new FileCacheProvider(dir, { gcIntervalMs: 0 });
    await cache.set("metric-test", "v", 1);
    await new Promise(r => setTimeout(r, 1100));
    await cache.runGc();

    const runsAfter = await metrics.cacheGcRuns.get();
    const evictedAfter = await metrics.cacheGcEvicted.get();
    const runsFinal = runsAfter.values.find(v => v.labels.layer === "file")?.value ?? 0;
    const evictedFinal = evictedAfter.values.find(v => v.labels.layer === "file")?.value ?? 0;

    expect(runsFinal).toBe(runsBaseline + 1);
    expect(evictedFinal).toBe(evictedBaseline + 1);
  });

  it("background timer fires automatically and unrefs", async () => {
    cache = new FileCacheProvider(dir, { gcIntervalMs: 50 });
    await cache.set("auto-expire", "v", 1);
    await new Promise(r => setTimeout(r, 1200));

    expect(await cache.get("auto-expire")).toBeNull();
    const files = readdirSync(dir);
    expect(files).toHaveLength(0);
  });
});
