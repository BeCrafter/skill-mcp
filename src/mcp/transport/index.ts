import type { TransportType } from "../../types/index.js";

export function parseTransportType(arg?: string): TransportType {
  if (!arg) return "stdio";
  if (arg === "stdio" || arg === "sse" || arg === "http") {
    return arg;
  }
  console.warn(`Unknown transport type: ${arg}, defaulting to stdio`);
  return "stdio";
}
