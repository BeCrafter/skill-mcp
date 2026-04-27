import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export function attachRequestId(req: IncomingMessage, res: ServerResponse): string {
  const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
  res.setHeader("X-Request-ID", requestId);
  return requestId;
}
