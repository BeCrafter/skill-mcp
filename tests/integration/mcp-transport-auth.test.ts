import Database from "better-sqlite3";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ensureDistBuilt,
  getFreePort,
  seedRbac,
  spawnHttpServer,
  writeSkillPackage,
  type SpawnedServer,
} from "./_helpers.js";

/**
 * Regression coverage for T-738 — verify Authorization: Bearer is propagated
 * end-to-end through both MCP transports into the request context. Anti-test:
 * before the fix, MCP HTTP/SSE callers always landed in an anonymous context
 * regardless of header, so private skills were invisible even to their owner.
 *
 * Strategy: seed a `private` skill that the seeded user's role tag has access
 * to. Authenticated MCP `tools/call skill_list` MUST contain the slug;
 * anonymous MCP `tools/call skill_list` MUST NOT (TagPermissionFilter drops
 * private skills for unauthenticated callers).
 */

const PRIVATE_SKILL_SLUG = "mcp-auth-private";
const SHARED_TAG = "mcp-auth-test";

function seedTaggedPrivateSkill(dbPath: string, slug: string, tag: string): void {
  const sqlite = new Database(dbPath);
  const id = randomUUID();
  const now = Date.now();
  sqlite.prepare(
    `INSERT INTO skills (id, slug, name, description, version, status, visibility, attributes, entry_file, storage_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, slug, slug, "test", "1.0.0", "published", "private", "{}", "SKILL.md", `${slug}/`, now, now);
  sqlite.prepare(`INSERT INTO skill_tags (skill_id, tag) VALUES (?, ?)`).run(id, tag);
  sqlite.close();
}

interface JsonRpcMsg {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: { content?: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}

/** Parse SDK responses that might come back as raw JSON or as a single SSE event. */
function parseMcpBody(text: string, contentType: string | null): JsonRpcMsg {
  if (contentType?.includes("text/event-stream")) {
    const dataLine = text.split("\n").find(l => l.startsWith("data:"));
    if (!dataLine) throw new Error(`SSE response had no data line: ${text}`);
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

async function mcpHttpCall(
  url: string,
  body: unknown,
  opts: { token?: string; sessionId?: string } = {},
): Promise<{ msg: JsonRpcMsg; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.sessionId) headers["mcp-session-id"] = opts.sessionId;
  const res = await fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status >= 400) {
    throw new Error(`MCP HTTP ${res.status}: ${text}`);
  }
  const msg = parseMcpBody(text, res.headers.get("content-type"));
  return { msg, sessionId: res.headers.get("mcp-session-id") };
}

/** Initialize handshake; returns the negotiated session id and the parsed response. */
async function mcpHttpInitializeFull(url: string, token?: string): Promise<{ sessionId: string; msg: JsonRpcMsg }> {
  const { sessionId, msg } = await mcpHttpCall(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "regression-test", version: "0.0.0" },
    },
  }, { token });
  if (!sessionId) throw new Error("server did not return mcp-session-id");
  return { sessionId, msg };
}

async function mcpHttpInitialize(url: string, token?: string): Promise<string> {
  return (await mcpHttpInitializeFull(url, token)).sessionId;
}

async function mcpHttpListSkills(url: string, sessionId: string, token?: string): Promise<string> {
  const { msg } = await mcpHttpCall(url, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "skill_list", arguments: {} },
  }, { token, sessionId });
  if (msg.error) throw new Error(`tools/call error: ${msg.error.message}`);
  return msg.result?.content?.[0]?.text ?? "";
}

describe("MCP transport auth bridge (T-738)", () => {
  let testDir: string;
  let httpServer: SpawnedServer | null = null;
  let sseServer: SpawnedServer | null = null;
  let validToken: string;

  beforeAll(async () => {
    ensureDistBuilt();
    testDir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
    const dbPath = join(testDir, "skill-mcp.db");
    const storagePath = join(testDir, "data/skills");

    validToken = seedRbac(dbPath, { tags: [SHARED_TAG], tokenLabel: "mcp-auth-tok" }).token;
    writeSkillPackage(storagePath, PRIVATE_SKILL_SLUG, "# private");
    seedTaggedPrivateSkill(dbPath, PRIVATE_SKILL_SLUG, SHARED_TAG);

    // Two servers because /mcp (Streamable HTTP) and /mcp/sse (SSE) are
    // mutually exclusive transports — `serve --transport` toggles which one
    // app.ts mounts. They share the same DB / storage so one seed covers both.
    const httpPort = await getFreePort();
    httpServer = await spawnHttpServer({
      port: httpPort,
      transport: "http",
      env: {
        NODE_ENV: "test",
        DEPLOYMENT_MODE: "standalone",
        DATABASE_PATH: dbPath,
        STORAGE_BASE_PATH: storagePath,
        CACHE_FILE_DIR: join(testDir, "cache-http"),
      },
    });

    const ssePort = await getFreePort();
    sseServer = await spawnHttpServer({
      port: ssePort,
      transport: "sse",
      env: {
        NODE_ENV: "test",
        DEPLOYMENT_MODE: "standalone",
        DATABASE_PATH: dbPath,
        STORAGE_BASE_PATH: storagePath,
        CACHE_FILE_DIR: join(testDir, "cache-sse"),
      },
    });
  }, 60_000);

  afterAll(async () => {
    await httpServer?.stop();
    await sseServer?.stop();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  describe("Streamable HTTP /mcp", () => {
    it("authenticated bearer surfaces the user's private skill via skill_list", async () => {
      const sid = await mcpHttpInitialize(httpServer!.url, validToken);
      const text = await mcpHttpListSkills(httpServer!.url, sid, validToken);
      expect(text).toContain(PRIVATE_SKILL_SLUG);
    });

    it("anonymous request (no bearer) does not see the private skill", async () => {
      const sid = await mcpHttpInitialize(httpServer!.url);
      const text = await mcpHttpListSkills(httpServer!.url, sid);
      expect(text).not.toContain(PRIVATE_SKILL_SLUG);
    });

    // Regression: initialize.result.instructions used to enumerate every
    // published skill via an unfiltered listSkills() at server-construction
    // time, leaking private slugs/descriptions to anonymous callers. The
    // catalog now lives exclusively in skill_list (RBAC-filtered), so the
    // initialize handshake must never reference a specific skill.
    it("initialize.instructions does not leak private skill metadata to anonymous callers", async () => {
      const { msg } = await mcpHttpInitializeFull(httpServer!.url);
      const result = msg.result as { instructions?: string } | undefined;
      const instructions = result?.instructions ?? "";
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).not.toContain(PRIVATE_SKILL_SLUG);
      expect(instructions).not.toContain(SHARED_TAG);
      expect(instructions).not.toContain("<available_skills>");
    });

    it("initialize.instructions does not embed any skill catalog even for the owner", async () => {
      const { msg } = await mcpHttpInitializeFull(httpServer!.url, validToken);
      const result = msg.result as { instructions?: string } | undefined;
      const instructions = result?.instructions ?? "";
      expect(instructions).not.toContain(PRIVATE_SKILL_SLUG);
      expect(instructions).not.toContain("<available_skills>");
    });
  });

  describe("SSE /mcp/sse + /mcp/messages", () => {
    interface SseClient {
      sessionId: string;
      /** Resolve when a JSON-RPC response with this id arrives on the stream. */
      waitForResponse(id: number, timeoutMs?: number): Promise<JsonRpcMsg>;
      close(): void;
    }

    /**
     * Open an SSE GET, parse the `endpoint` event for the sessionId, and keep
     * the stream open so JSON-RPC replies pushed by the server (in response
     * to POSTs against /mcp/messages) can be matched by id. Each test must
     * call close() to release the connection.
     */
    async function openSseClient(serverUrl: string): Promise<SseClient> {
      const abort = new AbortController();
      const res = await fetch(`${serverUrl}/mcp/sse`, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (res.status !== 200 || !res.body) {
        throw new Error(`SSE GET failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const pending = new Map<number, (msg: JsonRpcMsg) => void>();
      let sessionResolver: ((sid: string) => void) | null = null;
      const sessionPromise = new Promise<string>(r => { sessionResolver = r; });
      let buf = "";

      void (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) return;
            buf += decoder.decode(value, { stream: true });
            // Events are separated by blank lines. Drain complete events from buf.
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              const block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const dataLine = block.split("\n").find(l => l.startsWith("data:"));
              if (!dataLine) continue;
              const data = dataLine.slice("data:".length).trim();
              const endpointMatch = data.match(/^\/mcp\/messages\?sessionId=(.+)$/);
              if (endpointMatch) {
                sessionResolver?.(endpointMatch[1]);
                continue;
              }
              try {
                const msg = JSON.parse(data) as JsonRpcMsg;
                if (typeof msg.id === "number") {
                  const r = pending.get(msg.id);
                  if (r) { pending.delete(msg.id); r(msg); }
                }
              } catch { /* non-JSON event, ignore */ }
            }
          }
        } catch { /* aborted or stream closed */ }
      })();

      const sessionId = await Promise.race([
        sessionPromise,
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error("endpoint event timeout")), 15_000)),
      ]);

      return {
        sessionId,
        waitForResponse(id, timeoutMs = 15_000) {
          return new Promise<JsonRpcMsg>((resolveP, rejectP) => {
            pending.set(id, resolveP);
            setTimeout(() => {
              if (pending.delete(id)) rejectP(new Error(`Timed out waiting for SSE response id=${id}`));
            }, timeoutMs);
          });
        },
        close() { abort.abort(); },
      };
    }

    async function ssePost(serverUrl: string, sessionId: string, body: unknown, token?: string): Promise<Response> {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      return fetch(`${serverUrl}/mcp/messages?sessionId=${sessionId}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    }

    it("authenticated SSE POST surfaces the private skill in the SSE-pushed reply", async () => {
      const client = await openSseClient(sseServer!.url);
      try {
        const initAck = await ssePost(sseServer!.url, client.sessionId, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "regression-sse", version: "0.0.0" },
          },
        }, validToken);
        expect(initAck.status).toBeLessThan(400);
        await client.waitForResponse(1);

        const callAck = await ssePost(sseServer!.url, client.sessionId, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "skill_list", arguments: {} },
        }, validToken);
        expect(callAck.status).toBeLessThan(400);

        const reply = await client.waitForResponse(2);
        expect(reply.error).toBeUndefined();
        const text = reply.result?.content?.[0]?.text ?? "";
        expect(text).toContain(PRIVATE_SKILL_SLUG);
      } finally {
        client.close();
      }
    }, 30_000);

    it("anonymous SSE POST (no bearer) does not surface the private skill", async () => {
      const client = await openSseClient(sseServer!.url);
      try {
        const initAck = await ssePost(sseServer!.url, client.sessionId, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "regression-sse-anon", version: "0.0.0" },
          },
        });
        expect(initAck.status).toBeLessThan(400);
        await client.waitForResponse(1);

        const callAck = await ssePost(sseServer!.url, client.sessionId, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "skill_list", arguments: {} },
        });
        expect(callAck.status).toBeLessThan(400);

        const reply = await client.waitForResponse(2);
        expect(reply.error).toBeUndefined();
        const text = reply.result?.content?.[0]?.text ?? "";
        expect(text).not.toContain(PRIVATE_SKILL_SLUG);
      } finally {
        client.close();
      }
    }, 30_000);
  });
});
