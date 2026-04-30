import type { ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TransportType } from "../../types/index.js";

export interface TransportOptions {
  type: TransportType;
  server?: McpServer;
  messagePath?: string;
  sessionIdGenerator?: () => string;
}

export interface CreatedTransport {
  transport: Transport;
  handler?: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>;
  type: TransportType;
}

export function createTransport(options: TransportOptions): CreatedTransport {
  const { type, server, messagePath = "/mcp/messages", sessionIdGenerator = () => crypto.randomUUID() } = options;

  switch (type) {
    case "stdio": {
      return { transport: new StdioServerTransport(), type: "stdio" };
    }

    case "sse": {
      if (!server) {
        throw new Error("MCP server is required for SSE transport");
      }

      let sseTransport: SSEServerTransport | null = null;

      const handler = async (
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse
      ): Promise<void> => {
        const url = req.url?.split("?")[0] ?? "";

        if (req.method === "GET" && url === "/mcp/sse") {
          sseTransport = new SSEServerTransport(messagePath, res);
          await server.connect(sseTransport);
          return;
        }

        if (req.method === "POST" && url === messagePath) {
          if (sseTransport) {
            await sseTransport.handlePostMessage(req, res);
          }
        }
      };

      return { transport: new SSEServerTransport(messagePath, {} as ServerResponse), handler, type: "sse" };
    }

    case "http": {
      if (!server) {
        throw new Error("MCP server is required for HTTP transport");
      }

      let httpTransport: StreamableHTTPServerTransport | null = null;

      const handler = async (
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse
      ): Promise<void> => {
        const url = req.url?.split("?")[0] ?? "";

        if (req.method === "POST" && url === "/mcp") {
          httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator });
          await server.connect(httpTransport);
          await httpTransport.handleRequest(req, res);
          return;
        }

        if (req.method === "GET" && url === "/mcp") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          });
          res.end();
          return;
        }

        if (req.method === "DELETE" && url === "/mcp") {
          if (httpTransport) {
            await httpTransport.handleRequest(req, res);
          }
        }
      };

      return { transport: new StreamableHTTPServerTransport({ sessionIdGenerator }), handler, type: "http" };
    }

    default:
      throw new Error(`Unknown transport type: ${type}`);
  }
}

export function parseTransportType(arg?: string): TransportType {
  if (!arg) return "stdio";
  if (arg === "stdio" || arg === "sse" || arg === "http") {
    return arg;
  }
  console.warn(`Unknown transport type: ${arg}, defaulting to stdio`);
  return "stdio";
}
