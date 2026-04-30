import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";
import type { RequestContext } from "../types/index.js";

export interface HttpContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: string;
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  requestContext?: RequestContext;
  logger: Logger;
}
