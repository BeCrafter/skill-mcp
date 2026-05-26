import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TransportType } from "../../types/index.js";

export interface TransportOptions {
  type: "stdio";
}

export interface CreatedTransport {
  transport: Transport;
  type: "stdio";
}

// SSE and Streamable HTTP transports are wired directly inside src/app.ts so
// per-session state and the raw http.Server can co-own request/response
// streams. This factory is now stdio-only — when adding a new transport here,
// keep app.ts as the source of truth for HTTP-mode session bookkeeping.
export function createTransport(options: TransportOptions): CreatedTransport {
  if (options.type !== "stdio") {
    throw new Error(`createTransport only supports stdio; got "${options.type}"`);
  }
  return { transport: new StdioServerTransport(), type: "stdio" };
}

export function parseTransportType(arg?: string): TransportType {
  if (!arg) return "stdio";
  if (arg === "stdio" || arg === "sse" || arg === "http") {
    return arg;
  }
  console.warn(`Unknown transport type: ${arg}, defaulting to stdio`);
  return "stdio";
}
