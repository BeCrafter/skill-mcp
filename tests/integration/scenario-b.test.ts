import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureDistBuilt,
  getFreePort,
  seedPublicSkill,
  seedRbac,
  spawnHttpServer,
  writeSkillPackage,
  type SpawnedServer,
} from "./_helpers.js";

/**
 * Scenario B: gateway in front of a remote cloud storage service.
 *
 *   client ──(Bearer userTok)──> Gateway HTTP ──(Bearer svcTok)──> Cloud HTTP
 *
 * The gateway uses `SKILL_MCP_AUTH_TOKEN` env to authenticate itself to the cloud; the
 * end user authenticates separately to the gateway with their own per-user
 * bearer token. Both DBs are pre-seeded with matching users/roles so the
 * spawned servers don't refuse the bearer at the gateway-auth middleware.
 */
describe("Scenario B: Local Gateway + Remote Cloud Storage", () => {
  let testDir: string;
  let cloudServer: SpawnedServer | null = null;
  let gatewayServer: SpawnedServer | null = null;
  let clientToken: string;
  let serviceToken: string;

  beforeAll(async () => {
    ensureDistBuilt();

    testDir = mkdtempSync(join(tmpdir(), "scenario-b-"));

    const cloudDir = join(testDir, "cloud");
    const gatewayDir = join(testDir, "gateway");
    const cloudDb = join(cloudDir, "skill-mcp.db");
    const gatewayDb = join(gatewayDir, "skill-mcp.db");
    const cloudStorage = join(cloudDir, "data/skills");
    const gatewayStorage = join(gatewayDir, "data/skills");

    // The cloud-side DB carries two users: a "service" identity used by the
    // gateway when proxying upstream, and the "client" identity that hits
    // the gateway directly. We reuse the same plaintext for the gateway-side
    // user to keep the test wiring simple.
    const cloudSvc = seedRbac(cloudDb, { tags: ["svc-gateway"], tokenLabel: "svc-tok-cloud" });
    const cloudClient = seedRbac(cloudDb, { tags: ["client"], tokenLabel: "client-tok" });
    seedRbac(gatewayDb, { tags: ["client"], tokenLabel: cloudClient.token });
    serviceToken = cloudSvc.token;
    clientToken = cloudClient.token;

    writeSkillPackage(cloudStorage, "demo-skill-b", "# Demo Skill B");
    seedPublicSkill(cloudDb, "demo-skill-b");
    writeSkillPackage(gatewayStorage, "demo-skill-b", "# Demo Skill B");

    const cloudPort = await getFreePort();
    cloudServer = await spawnHttpServer({
      port: cloudPort,
      env: {
        NODE_ENV: "test",
        DATABASE_PATH: cloudDb,
        STORAGE_BASE_PATH: cloudStorage,
        CACHE_FILE_DIR: join(cloudDir, "cache"),
      },
    });

    const gatewayPort = await getFreePort();
    gatewayServer = await spawnHttpServer({
      port: gatewayPort,
      env: {
        NODE_ENV: "test",
        CLOUD_SERVICE_URL: cloudServer.url,
        SKILL_MCP_AUTH_TOKEN: serviceToken,
        DATABASE_PATH: gatewayDb,
        STORAGE_BASE_PATH: gatewayStorage,
        CACHE_FILE_DIR: join(gatewayDir, "cache"),
      },
    });
  }, 60_000);

  afterAll(async () => {
    await gatewayServer?.stop();
    await cloudServer?.stop();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  it("cloud /api/health is unauthenticated and returns 200", async () => {
    const r = await fetch(`${cloudServer!.url}/api/health`);
    expect(r.status).toBe(200);
    const body = await r.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("cloud rejects /api/gateway/skills without bearer", async () => {
    const r = await fetch(`${cloudServer!.url}/api/gateway/skills`);
    expect(r.status).toBe(401);
  });

  it("cloud rejects /api/gateway/skills with invalid bearer", async () => {
    const r = await fetch(`${cloudServer!.url}/api/gateway/skills`, {
      headers: { Authorization: "Bearer bogus-token-xyz" },
    });
    expect(r.status).toBe(401);
  });

  it("cloud accepts /api/gateway/skills with valid client bearer", async () => {
    const r = await fetch(`${cloudServer!.url}/api/gateway/skills`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { data: Array<{ slug: string }> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.find(s => s.slug === "demo-skill-b")).toBeTruthy();
  });

  it("gateway forwards client bearer to cloud and returns the same skill list", async () => {
    const r = await fetch(`${gatewayServer!.url}/api/gateway/skills`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { data: Array<{ slug: string }> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.find(s => s.slug === "demo-skill-b")).toBeTruthy();
  });

  it("gateway rejects requests without a bearer (no anonymous passthrough)", async () => {
    const r = await fetch(`${gatewayServer!.url}/api/gateway/skills`);
    expect(r.status).toBe(401);
  });

  it("gateway rejects requests whose bearer is unknown to the gateway DB", async () => {
    const r = await fetch(`${gatewayServer!.url}/api/gateway/skills`, {
      headers: { Authorization: "Bearer not-a-real-user" },
    });
    expect(r.status).toBe(401);
  });

  it("two consecutive list requests both succeed (RemoteProvider stays healthy)", async () => {
    const headers = { Authorization: `Bearer ${clientToken}` };
    const r1 = await fetch(`${gatewayServer!.url}/api/gateway/skills`, { headers });
    const r2 = await fetch(`${gatewayServer!.url}/api/gateway/skills`, { headers });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it("both spawned servers are still alive at the end of the suite", () => {
    expect(cloudServer!.process.exitCode).toBeNull();
    expect(gatewayServer!.process.exitCode).toBeNull();
  });
});
