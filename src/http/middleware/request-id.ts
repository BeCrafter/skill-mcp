import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { activeTraceId } from "../../telemetry/spans.js";

/**
 * P0-6 — when OpenTelemetry is registered and an active span exists, prefer
 * the W3C `traceId` so pino logs (which echo `requestId`) and OTel spans
 * share a single correlation key. Falls back to the inbound `X-Request-ID`
 * header (legacy / proxy-supplied) and finally to a fresh UUID.
 */
export function attachRequestId(req: IncomingMessage, res: ServerResponse): string {
  const headerId = (req.headers["x-request-id"] as string | undefined) ?? null;
  const traceId = activeTraceId();
  const requestId = headerId ?? traceId ?? randomUUID();
  res.setHeader("X-Request-ID", requestId);
  return requestId;
}
