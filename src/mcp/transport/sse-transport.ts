import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpServer } from "../server.js";
import { json } from "../../http/helpers.js";
import { metrics } from "../../telemetry/metrics.js";
import { getLogger } from "../../utils/logger.js";
import type { ISkillProvider } from "../../provider/interface.js";
import type { SkillService } from "../../services/skill.service.js";
import type { ContextBuilder } from "../../permission/context-builder.js";
import { attachMcpAuthFromHeaders } from "../../permission/context-builder.js";
import type { PipelineRunStore } from "../../pipeline/run-store.js";
import type { UsageMeterService } from "../../services/usage-meter.service.js";

export interface SseMcpHandlerDeps {
  skillService: SkillService;
  skillProvider: ISkillProvider;
  serverName: string;
  serverVersion: string;
  pipelineRunStore?: PipelineRunStore;
  usageMeter?: UsageMeterService;
}

const SSE_IDLE_TIMEOUT_MS = 2 * 60 * 1000;   // 2 min (was 30 min) — faster cleanup on disconnect
const SSE_SWEEP_INTERVAL_MS = 30 * 1000;     // 30s (was 5 min) — faster sweep for dev scenarios

export async function createSseMcpHandler(
  deps: SseMcpHandlerDeps,
  contextBuilder?: ContextBuilder,
): Promise<(req: IncomingMessage, res: ServerResponse) => Promise<void>> {
  const logger = getLogger();
  const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");

  type SseSession = {
    transport: InstanceType<typeof SSEServerTransport>;
    server: Awaited<ReturnType<typeof createMcpServer>>;
    lastActivity: number;
  };
  const sseConnections = new Map<string, SseSession>();

  // Mirror the HTTP reaper (T-206): SSE clients can drop the underlying socket
  // without firing `close` (NAT timeout, abrupt power loss). Sweep idle sessions
  // so a stale connection can't pin an McpServer forever.
  const sseSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, session] of sseConnections) {
      if (now - session.lastActivity > SSE_IDLE_TIMEOUT_MS) {
        sseConnections.delete(sid);
        metrics.mcpActiveSessions.dec({ transport: "sse" });
        session.server.close().catch((err) => logger.debug({ err, sid }, "idle SSE session close failed"));
        logger.info({ sessionId: sid, idleMs: now - session.lastActivity }, "Reaped idle SSE session");
      }
    }
  }, SSE_SWEEP_INTERVAL_MS);
  sseSweepTimer.unref();

  return async (req, res) => {
    const url = req.url?.split("?")[0] ?? "";

    if (req.method === "GET" && url === "/mcp/sse") {
      try {
        const server = await createMcpServer(deps.skillService, deps.skillProvider, deps.serverName, deps.serverVersion, contextBuilder, deps.pipelineRunStore, deps.usageMeter);
        const transport = new SSEServerTransport("/mcp/messages", res);
        // Use transport's own sessionId — it embeds this in the endpoint event sent to the client,
        // so POST requests will arrive with this exact ID.
        const sessionId = transport.sessionId;
        sseConnections.set(sessionId, { transport, server, lastActivity: Date.now() });
        metrics.mcpActiveSessions.inc({ transport: "sse" });

        await server.connect(transport);

        // Wrap the transport's send method to catch "Not connected" errors
        // that occur when the SSE response stream is closed.
        const originalSend = transport.send.bind(transport);
        transport.send = async (message) => {
          try {
            await originalSend(message);
          } catch (err) {
            if (err instanceof Error && err.message === "Not connected") {
              logger.debug({ sessionId }, "SSE client disconnected during send");
              cleanup();
            } else {
              throw err;
            }
          }
        };

        // Guard against double-fire from close/finish so the gauge stays accurate.
        const cleanup = () => {
          const session = sseConnections.get(sessionId);
          if (session) {
            sseConnections.delete(sessionId);
            metrics.mcpActiveSessions.dec({ transport: "sse" });
            session.server.close().catch((err) => logger.debug({ err }, "Error closing SSE server"));
          }
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
        res.on("finish", cleanup);

        // Handle transport-level errors
        transport.onerror = (err) => {
          logger.warn({ err, sessionId }, "SSE transport error");
        };
      } catch (err) {
        logger.error({ err }, "Failed to create SSE connection");
        json(res, 500, { error: "Failed to create SSE connection" });
      }
      return;
    }

    if (req.method === "POST" && url === "/mcp/messages") {
      const { URL: URLParser } = await import("node:url");
      const urlObj = new URLParser(req.url ?? "/", `http://${req.headers.host}`);
      const sessionId = urlObj.searchParams.get("sessionId");

      if (sessionId && sseConnections.has(sessionId)) {
        try {
          const session = sseConnections.get(sessionId)!;
          session.lastActivity = Date.now();
          // T-738 — bridge Authorization header onto req.auth so the SDK
          // passes it through to extra.authInfo on each posted message.
          attachMcpAuthFromHeaders(req as unknown as { headers: { authorization?: string | string[] }; auth?: { token?: string } });
          await session.transport.handlePostMessage(req, res);
          return;
        } catch (err) {
          logger.error({ err, sessionId }, "Error handling SSE message");
          if (sseConnections.delete(sessionId)) {
            metrics.mcpActiveSessions.dec({ transport: "sse" });
          }
          json(res, 500, { error: "Failed to handle SSE message" });
          return;
        }
      }

      // T-701 — drop the "single-session fallback". Previously, when exactly
      // one SSE connection was active, an authenticated POST without a
      // sessionId would be auto-routed to that session.
      // gateway this lets caller B's POST land in caller A's MCP session.
      // Require an explicit sessionId; missing or unknown → 400.
      json(res, 400, { error: "No active SSE session" });
      return;
    }
  };
}
