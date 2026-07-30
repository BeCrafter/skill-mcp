import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDistBuilt, getFreePort, seedRbac, seedPublicSkill, writeSkillPackage, spawnHttpServer, type SpawnedServer } from "./_helpers.js";

/**
 * C2 D-A smoke: verify the new `/api/gateway/skills/search` endpoint
 * on storage returns BM25-ranked results for a seeded skill, using
 * the gateway auth token. This is the endpoint that proxy-mode
 * mcp1/mcp2 will call via RemoteSkillProvider.search.
 */

let storageData: string;
let storageSkills: string;
let storageDb: string;

beforeAll(() => { ensureDistBuilt(); });

describe("C2 gateway search endpoint (D-A)", () => {
  let server: SpawnedServer;
  let token: string;

  beforeAll(async () => {
    storageData = mkdtempSync(join(tmpdir(), "c2-e2e-storage-"));
    storageSkills = join(storageData, "skills");
    storageDb = join(storageData, "skill-mcp.db");

    const rbac = seedRbac(storageDb, { tags: ["all"], tokenLabel: "c2-svc-token" });
    token = rbac.token;
    seedPublicSkill(storageDb, "web-access");
    writeSkillPackage(storageSkills, "web-access", "Access web pages and extract content.");

    const port = await getFreePort();
    server = await spawnHttpServer({
      port,
      env: {
        DATABASE_PATH: storageDb,
        STORAGE_BASE_PATH: storageSkills,
        SKILL_MCP_AUTH_TOKEN: token,
        TRANSPORT_TYPE: "http",
        TRANSPORT_PORT: String(port),
        API_ONLY_MODE: "true",
      },
    });
  }, 30_000);

  afterAll(async () => {
    await server.stop();
    rmSync(storageData, { recursive: true, force: true });
  });

  it("health check responds on storage", async () => {
    const resp = await fetch(`${server.url}/api/health`);
    expect(resp.status).toBe(200);
  });

  it("search returns the seeded skill when query matches", async () => {
    const resp = await fetch(`${server.url}/api/v1/gateway/skills/search?q=web+access`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    const hit = (body.data[0] as { skill: { slug: string; name: string }; score: number });
    expect(hit.skill.slug).toBe("web-access");
    expect(hit.score).toBeGreaterThan(0);
  });

  it("search respects legacy /api gateway alias (Sunset)", async () => {
    const resp = await fetch(`${server.url}/api/gateway/skills/search?q=web`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { success: boolean; data: unknown[] };
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("search returns empty for unmatched query", async () => {
    const resp = await fetch(`${server.url}/api/v1/gateway/skills/search?q=zzzzzzz_unlikely_xyz`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { success: boolean; data: unknown[] };
    expect(body.data.length).toBe(0);
  });

  it("search returns 400 for empty query", async () => {
    const resp = await fetch(`${server.url}/api/v1/gateway/skills/search`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(400);
  });
});
