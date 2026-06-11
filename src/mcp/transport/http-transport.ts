import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createMcpServer } from "../server.js";
import { json, readBody, RequestBodyTooLargeError } from "../../http/helpers.js";
import { metrics } from "../../telemetry/metrics.js";
import { getLogger } from "../../utils/logger.js";
import type { ISkillProvider } from "../../provider/interface.js";
import type { SkillService } from "../../services/skill.service.js";
import type { ContextBuilder } from "../../permission/context-builder.js";
import { attachMcpAuthFromHeaders } from "../../permission/context-builder.js";
import type { PipelineRunStore } from "../../pipeline/run-store.js";
import type { UsageMeterService } from "../../services/usage-meter.service.js";

export interface HttpMcpHandlerDeps {
  skillService: SkillService;
  skillProvider: ISkillProvider;
  serverName: string;
  serverVersion: string;
  pipelineRunStore?: PipelineRunStore;
  usageMeter?: UsageMeterService;
}

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// T-702 — cap MCP request body so an authenticated peer can't OOM the process
// by streaming an unbounded POST. Mirrors readBody's default 10 MiB cap on the
// admin / gateway REST surface.
const MAX_MCP_BODY_BYTES = 10 * 1024 * 1024;
// T-717 — cap caller-supplied `mcp-session-id`. Each unique value allocates
// a new McpServer + transport into the in-memory `httpSessions` Map until
// the 5-min reaper sweeps idle entries; an attacker varying the header per
// request can balloon the Map in seconds. Constrain to a length that fits
// every legitimate UUIDv4 / opaque id and a charset that disallows path /
// header smuggling. Anything outside the allow-list falls back to a fresh
// server-generated UUID.
const MAX_SESSION_ID_LENGTH = 128;
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

export async function createHttpMcpHandler(
  deps: HttpMcpHandlerDeps,
  contextBuilder?: ContextBuilder,
): Promise<(req: IncomingMessage, res: ServerResponse) => Promise<void>> {
  const logger = getLogger();
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

  type HttpSession = {
    transport: InstanceType<typeof StreamableHTTPServerTransport>;
    server: Awaited<ReturnType<typeof createMcpServer>>;
    lastActivity: number;
  };
  const httpSessions = new Map<string, HttpSession>();

  // Idle reaper: a long-lived MCP session that goes silent (client crash,
  // dropped connection without close event) would otherwise pin a McpServer
  // forever. Sweep idle sessions every 5 min.
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, session] of httpSessions) {
      if (now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
        httpSessions.delete(sid);
        session.server.close().catch((err) => logger.debug({ err, sid }, "idle session close failed"));
        metrics.mcpActiveSessions.dec({ transport: "http" });
        logger.info({ sessionId: sid, idleMs: now - session.lastActivity }, "Reaped idle MCP session");
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  return async (req, res) => {
    // Read body first - required because getRequestListener from @hono/node-server
    // sets wrapBodyStream AFTER newRequest is called, so passing req directly
    // results in a Request with no body and req.json() hangs indefinitely.
    let parsedBody: unknown;
    if (req.method === "POST") {
      let buf: Buffer;
      try {
        buf = await readBody(req, MAX_MCP_BODY_BYTES);
      } catch (err) {
        if (err instanceof RequestBodyTooLargeError) {
          json(res, 413, { error: "Request body too large", limit: err.limit });
          return;
        }
        json(res, 400, { error: "Failed to read request body" });
        return;
      }
      try { parsedBody = JSON.parse(buf.toString()); } catch { /* will be rejected by transport */ }
    }

    const headerSid = req.headers["mcp-session-id"];
    const rawSid = typeof headerSid === "string" ? headerSid : "";
    const sessionId = rawSid && rawSid.length <= MAX_SESSION_ID_LENGTH && SESSION_ID_RE.test(rawSid)
      ? rawSid
      : randomUUID();

    try {
      if (!httpSessions.has(sessionId)) {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId, enableJsonResponse: true });
        const server = await createMcpServer(deps.skillService, deps.skillProvider, deps.serverName, deps.serverVersion, contextBuilder, deps.pipelineRunStore, deps.usageMeter);
        await server.connect(transport);
        httpSessions.set(sessionId, { transport, server, lastActivity: Date.now() });
        metrics.mcpActiveSessions.inc({ transport: "http" });
        // T-718 — do NOT cleanup on req close. With keep-alive the request's
        // 'close' fires after every individual POST, but a Streamable HTTP
        // session is meant to persist across many requests sharing the same
        // mcp-session-id. Tearing down here would force a fresh McpServer per
        // request and make the session map / idle reaper useless. Lifecycle
        // is owned by the idle reaper (30 min) and DELETE handling below.
      }

      const session = httpSessions.get(sessionId)!;
      session.lastActivity = Date.now();
      // T-738 — bridge Authorization header onto req.auth so the SDK passes
      // it through to extra.authInfo, which our context builder reads.
      attachMcpAuthFromHeaders(req as unknown as { headers: { authorization?: string | string[] }; auth?: { token?: string } });
      await session.transport.handleRequest(req, res, parsedBody);

      // T-718 — explicit teardown via DELETE /mcp (per MCP spec): the client
      // can signal the end of a session and free the McpServer immediately
      // rather than waiting on the 30-min idle sweep.
      if (req.method === "DELETE") {
        const session = httpSessions.get(sessionId);
        if (session) {
          httpSessions.delete(sessionId);
          metrics.mcpActiveSessions.dec({ transport: "http" });
          session.server.close().catch((err) => logger.debug({ err, sessionId }, "session close failed"));
        }
      }
    } catch (err) {
      logger.error({ err, sessionId }, "Error handling Streamable HTTP request");
      if (!res.headersSent) {
        json(res, 500, { error: "Failed to handle HTTP request" });
      }
    }
  };
}
