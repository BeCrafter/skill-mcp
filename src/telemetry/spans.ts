/**
 * P0-6 — withSpan helper for manual instrumentation.
 *
 * The OpenTelemetry API is a no-op when no SDK is registered, so calling
 * `withSpan(...)` is always safe — wrapped operations behave identically to
 * an unwrapped call when tracing is disabled.
 *
 * Span naming follows commercialization-review §17.6:
 *   mcp.tool.{name}    — MCP tool boundaries
 *   auth.resolve       — buildRequestContext
 *   skill.service.{m}  — SkillService methods
 *   cache.epoch        — CacheEpochManager lookup
 *   cache.l1.get       — memory cache get
 *   cache.l2.get       — file cache get
 *   db.query           — repository methods
 *   storage.read       — storage provider reads
 *   perm.filter        — TagPermissionFilter
 *   audit.write        — access log writes
 *   pipeline.{runId}   — full pipeline execution
 *   pipeline.batch     — batch within a run
 *   pipeline.stage     — stage within a batch
 *   pipeline.stage.persist
 *   pipeline.persist   — final pipeline persist
 *
 * Every span carries `user_id` / `session_id` when a RequestContext is
 * available so per-user filtering works in the trace UI.
 */
import { SpanStatusCode, trace, type Attributes, type Tracer } from "@opentelemetry/api";
import type { RequestContext } from "../types/index.js";
import { getTracer } from "./tracing.js";

export const ATTR_USER_ID = "skill_mcp.user_id";
export const ATTR_SESSION_ID = "skill_mcp.session_id";

export interface SpanOpts {
  attributes?: Attributes;
  ctx?: Pick<RequestContext, "userId" | "sessionId"> | null;
  tracer?: Tracer;
}

function attachContextAttrs(attrs: Attributes, ctx: SpanOpts["ctx"]): Attributes {
  if (!ctx) return attrs;
  return {
    ...attrs,
    [ATTR_USER_ID]: ctx.userId,
    ...(ctx.sessionId ? { [ATTR_SESSION_ID]: ctx.sessionId } : {}),
  };
}

/**
 * Wrap an async operation with a span. The span:
 *  - inherits attributes from `opts.attributes` plus tenant/user from `opts.ctx`
 *  - records exceptions and sets status=ERROR on throw
 *  - is always ended (finally), so leaks are impossible
 *
 * When the SDK is not registered, `tracer.startActiveSpan` calls `fn` with a
 * no-op span — the wrapper still works as a plain pass-through.
 */
export async function withSpan<T>(
  name: string,
  opts: SpanOpts,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = opts.tracer ?? getTracer();
  return tracer.startActiveSpan(name, { attributes: attachContextAttrs(opts.attributes ?? {}, opts.ctx) }, async (span) => {
    try {
      const result = await fn();
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Synchronous variant for hot-path call sites that should not pay an await. */
export function withSpanSync<T>(
  name: string,
  opts: SpanOpts,
  fn: () => T,
): T {
  const tracer = opts.tracer ?? getTracer();
  return tracer.startActiveSpan(name, { attributes: attachContextAttrs(opts.attributes ?? {}, opts.ctx) }, (span) => {
    try {
      return fn();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Returns the W3C trace_id of the active span, or null when no SDK is
 * registered or no span is active. Used by request-id middleware to align
 * pino's `requestId` field with `trace_id` (§17.6 — pino integration).
 */
export function activeTraceId(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  if (!ctx || !ctx.traceId || ctx.traceId === "00000000000000000000000000000000") return null;
  return ctx.traceId;
}
