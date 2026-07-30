import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Use an inbound request ID when supplied, otherwise create a local UUID. */
export function attachRequestId(req: IncomingMessage, res: ServerResponse): string {
  const headerId = req.headers["x-request-id"];
  const requestId = (typeof headerId === "string" && headerId.trim()) || randomUUID();
  res.setHeader("X-Request-ID", requestId);
  return requestId;
}
