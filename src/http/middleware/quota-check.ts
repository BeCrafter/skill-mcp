import type { Middleware } from "../compose.js";
import type { HttpContext } from "../context.js";
import { named } from "../compose.js";
import { json } from "../helpers.js";
import { metrics } from "../../telemetry/metrics.js";
import type { QuotaService, QuotaDimension } from "../../services/quota.service.js";

// P1-13.5 — Quota check middleware (review §11 #13.5).
//
// RBAC vs Quota (review §9.1): RBAC says "can you do this at all" (403 on
// fail); Quota says "how much can you do" (429 on fail). We surface that
// distinction in the response body so clients can branch — automation
// retries 429 with backoff, alerts on 403.
//
// Performance: the QuotaService caches resolved limits per-user for 5s,
// so the hot-path overhead per request is one `usage_events` index probe
// (a `SUM(quantity)` over the day window). With WAL mode that's well
// under a millisecond at free/team tier volumes; for enterprise we can
// batch via Redis later (review §9.1 perf note).

export interface QuotaCheckOptions {
  quotaService: QuotaService;
  /** Dimension to check. Most callers pass `"api_calls"` (per request). */
  dimension: QuotaDimension;
  /**
   * with a `default` fallback so anonymous traffic shares one bucket.
   */
  identityExtractor?: (ctx: HttpContext) => string;
  /**
   * How many units this dimension consumes per request. Default 1. For
   * dimensions where the unit varies per request (e.g. `storage_bytes`),
   * pass a function that reads from `ctx.req`.
   */
  increment?: number | ((ctx: HttpContext) => number);
  /**
   * Whether to skip the check entirely (e.g. for liveness probes).
   * Default: skip when method == "GET" and url ends in `/health`.
   */
  skip?: (ctx: HttpContext) => boolean;
  /** Label fed to the `quotaCheckDenied` counter. */
  scope: "admin" | "gateway";
}


const DEFAULT_SKIP = (ctx: HttpContext): boolean =>
  ctx.method === "GET" && (ctx.url === "/api/gateway/health" || ctx.url === "/health");

export function createQuotaCheck(options: QuotaCheckOptions): Middleware {
  const {
    quotaService,
    dimension,
    increment = 1,
    skip = DEFAULT_SKIP,
    scope,
  } = options;

  return named("quotaCheck", async (ctx, next) => {
    if (skip(ctx)) {
      await next();
      return;
    }
    const inc = typeof increment === "function" ? increment(ctx) : increment;
    const result = await quotaService.check({ tenantId: ctx.requestContext?.tenantId ?? "default", dimension, increment: inc });

    // Always surface limit + remaining as headers so clients can self-meter
    // even on success. Match `X-RateLimit-*` shape so consumers don't need
    // a second header convention.
    if (Number.isFinite(result.limit)) {
      ctx.res.setHeader("X-Quota-Limit", String(result.limit));
      ctx.res.setHeader("X-Quota-Remaining", String(Math.max(0, result.remaining)));
      ctx.res.setHeader("X-Quota-Source", result.source);
    }

    if (result.ok) {
      await next();
      return;
    }

    metrics.quotaCheckDenied.inc({ scope, dimension });
    if (!ctx.res.headersSent) {
      ctx.res.setHeader("Retry-After", "60"); // generic — exact reset is "next UTC midnight"
      json(ctx.res, 429, {
        success: false,
        error: "Quota exceeded",
        dimension,
        limit: result.limit,
        used: result.used,
        retryAfterSec: 60,
      });
    }
  });
}
