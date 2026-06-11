import type { Middleware } from "../compose.js";
import type { HttpContext } from "../context.js";
import { named } from "../compose.js";
import { json } from "../helpers.js";
import { metrics } from "../../telemetry/metrics.js";

/**
 * P0-3 (commercialization-review §11 P0 #5) — In-memory token bucket per
 * caller identity. First step toward a Redis-backed implementation; the
 * algorithm and headers stay the same so callers do not need to change.
 *
 * Per-bucket state is `{ tokens, lastRefillMs }`. On each request:
 *   1. Refill: tokens += elapsedSec * refillPerSec, capped at capacity
 *   2. If tokens >= 1, decrement and pass through
 *   3. Else, write 429 + Retry-After + RateLimit-* headers and short-circuit
 *
 * Idle buckets are GC'd by a periodic sweep (default 5 min) to keep the Map
 * bounded under abuse. The interval is `unref()`'d so it never holds the
 * Node event loop open at shutdown.
 */
export interface RateLimitOptions {
  /** Bucket capacity (burst size). 1 token = 1 request. */
  capacity: number;
  /** Tokens added per second to each bucket. */
  refillPerSec: number;
  /**
   * Resolver for the bucket key. Defaults to `ctx.requestContext?.userId`
   * with `__anonymous__` fallback so unauthenticated traffic shares one
   * bucket (and cannot exhaust per-user buckets).
   */
  keyExtractor?: (ctx: HttpContext) => string;
  /**
   * Label fed to the `rateLimitDenied` counter. Set per-router so dashboards
   * can distinguish admin vs gateway pressure.
   */
  scope: "admin" | "gateway";
  /** GC sweep interval in ms. Default 5 min. */
  gcIntervalMs?: number;
  /** Idle bucket eviction threshold in ms. Default 10 min. */
  idleEvictMs?: number;
  /**
   * Injected clock for tests — production passes `Date.now`. Centralized
   * instead of sprinkling `Date.now()` calls so a single fake clock drives
   * both refill and GC deterministically.
   */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

interface RateLimitMiddleware extends Middleware {
  /** Drop the GC interval — only meaningful in tests / dynamic reload. */
  stop(): void;
  /** Test-only: peek at bucket state. */
  _bucketsForTest(): Map<string, Bucket>;
}

const DEFAULT_KEY_EXTRACTOR = (ctx: HttpContext): string =>
  ctx.requestContext?.userId ?? "__anonymous__";

export function createRateLimit(options: RateLimitOptions): RateLimitMiddleware {
  const {
    capacity,
    refillPerSec,
    keyExtractor = DEFAULT_KEY_EXTRACTOR,
    scope,
    gcIntervalMs = 5 * 60 * 1000,
    idleEvictMs = 10 * 60 * 1000,
    now = Date.now,
  } = options;

  if (capacity <= 0 || refillPerSec <= 0) {
    throw new Error("createRateLimit: capacity and refillPerSec must be > 0");
  }

  const buckets = new Map<string, Bucket>();

  const refillBucket = (b: Bucket, t: number): void => {
    const elapsedSec = Math.max(0, (t - b.lastRefillMs) / 1000);
    if (elapsedSec > 0) {
      b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
      b.lastRefillMs = t;
    }
  };

  const gcSweep = (): void => {
    const t = now();
    for (const [k, b] of buckets) {
      if (t - b.lastRefillMs >= idleEvictMs) {
        buckets.delete(k);
      }
    }
  };

  const gcTimer = setInterval(gcSweep, gcIntervalMs);
  gcTimer.unref();

  const middleware = named("rateLimit", async (ctx, next) => {
    const key = keyExtractor(ctx);
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefillMs: t };
      buckets.set(key, bucket);
    } else {
      refillBucket(bucket, t);
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      ctx.res.setHeader("X-RateLimit-Limit", String(capacity));
      ctx.res.setHeader("X-RateLimit-Remaining", String(Math.floor(bucket.tokens)));
      await next();
      return;
    }

    metrics.rateLimitDenied.inc({ scope });
    const deficit = 1 - bucket.tokens;
    const retryAfterSec = Math.max(1, Math.ceil(deficit / refillPerSec));
    if (!ctx.res.headersSent) {
      ctx.res.setHeader("Retry-After", String(retryAfterSec));
      ctx.res.setHeader("X-RateLimit-Limit", String(capacity));
      ctx.res.setHeader("X-RateLimit-Remaining", "0");
      ctx.res.setHeader("X-RateLimit-Reset", String(retryAfterSec));
      json(ctx.res, 429, {
        success: false,
        error: "Rate limit exceeded",
        retryAfterSec,
      });
    }
  }) as RateLimitMiddleware;

  middleware.stop = () => clearInterval(gcTimer);
  middleware._bucketsForTest = () => buckets;
  return middleware;
}
