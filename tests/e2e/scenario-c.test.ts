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
} from "../integration/_helpers.js";

/**
 * Scenario C — distributed HTTP deployments. Two sub-scenarios:
 *
 *   C1 (standalone HTTP):  client ──Bearer──> single server (admin + gateway routes)
 *   C2 (gateway + cloud):  client ──Bearer──> Gateway ──Bearer(svc)──> Cloud
 *
 * The C2 gateway runs in MCP_ONLY_MODE so /api/admin/* is disabled while
 * /api/gateway/* still proxies to the cloud, mirroring a production split
 * where the client-facing process is hardened against admin operations.
 */
describe("Scenario C: Distributed HTTP Deployment", () => {
  let testDir: string;

  let c1Server: SpawnedServer | null = null;
  let c1Token: string;

  let c2Cloud: SpawnedServer | null = null;
  let c2Gateway: SpawnedServer | null = null;
  let c2ClientToken: string;
  let c2ServiceToken: string;

  beforeAll(async () => {
    ensureDistBuilt();
    testDir = mkdtempSync(join(tmpdir(), "scenario-c-"));

    // ── C1: standalone ──────────────────────────────────────────────
    const c1Dir = join(testDir, "c1");
    const c1Db = join(c1Dir, "skill-mcp.db");
    const c1Storage = join(c1Dir, "data/skills");
    c1Token = seedRbac(c1Db, { tags: ["c1-client"], tokenLabel: "c1-tok" }).token;
    writeSkillPackage(c1Storage, "c-test-skill-1", "# C1 Test");
    seedPublicSkill(c1Db, "c-test-skill-1");

    const c1Port = await getFreePort();
    c1Server = await spawnHttpServer({
      port: c1Port,
      env: {
        NODE_ENV: "test",
        DEPLOYMENT_MODE: "standalone",
        DATABASE_PATH: c1Db,
        STORAGE_BASE_PATH: c1Storage,
        CACHE_FILE_DIR: join(c1Dir, "cache"),
      },
    });

    // ── C2: cloud + gateway (MCP-only) ──────────────────────────────
    const cloudDir = join(testDir, "c2-cloud");
    const gwDir = join(testDir, "c2-gateway");
    const cloudDb = join(cloudDir, "skill-mcp.db");
    const gwDb = join(gwDir, "skill-mcp.db");
    const cloudStorage = join(cloudDir, "data/skills");
    const gwStorage = join(gwDir, "data/skills");

    const cloudSvc = seedRbac(cloudDb, { tags: ["svc-gateway"], tokenLabel: "c2-svc-tok" });
    const cloudClient = seedRbac(cloudDb, { tags: ["c2-client"], tokenLabel: "c2-client-tok" });
    seedRbac(gwDb, { tags: ["c2-client"], tokenLabel: cloudClient.token });
    c2ServiceToken = cloudSvc.token;
    c2ClientToken = cloudClient.token;

    writeSkillPackage(cloudStorage, "c-test-skill-2", "# C2 Test");
    seedPublicSkill(cloudDb, "c-test-skill-2");
    writeSkillPackage(gwStorage, "c-test-skill-2", "# C2 Test");

    const cloudPort = await getFreePort();
    c2Cloud = await spawnHttpServer({
      port: cloudPort,
      env: {
        NODE_ENV: "test",
        DEPLOYMENT_MODE: "standalone",
        DATABASE_PATH: cloudDb,
        STORAGE_BASE_PATH: cloudStorage,
        CACHE_FILE_DIR: join(cloudDir, "cache"),
      },
    });

    const gwPort = await getFreePort();
    c2Gateway = await spawnHttpServer({
      port: gwPort,
      env: {
        NODE_ENV: "test",
        DEPLOYMENT_MODE: "gateway",
        CLOUD_SERVICE_URL: c2Cloud.url,
        AUTH_TOKEN: c2ServiceToken,
        DATABASE_PATH: gwDb,
        STORAGE_BASE_PATH: gwStorage,
        CACHE_FILE_DIR: join(gwDir, "cache"),
      },
    });
  }, 90_000);

  afterAll(async () => {
    await c1Server?.stop();
    await c2Gateway?.stop();
    await c2Cloud?.stop();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  describe("C1: Single Server (standalone HTTP)", () => {
    it("exposes /api/gateway/health unauthenticated", async () => {
      const r = await fetch(`${c1Server!.url}/api/gateway/health`);
      expect(r.status).toBe(200);
    });

    it("rejects /api/gateway/skills without bearer", async () => {
      const r = await fetch(`${c1Server!.url}/api/gateway/skills`);
      expect(r.status).toBe(401);
    });

    it("returns the seeded skill on /api/gateway/skills with valid bearer", async () => {
      const r = await fetch(`${c1Server!.url}/api/gateway/skills`, {
        headers: { Authorization: `Bearer ${c1Token}` },
      });
      expect(r.status).toBe(200);
      const body = await r.json() as { data: Array<{ slug: string }> };
      expect(body.data.find(s => s.slug === "c-test-skill-1")).toBeTruthy();
    });

    it("exposes admin routes in standalone mode (MCP_ONLY_MODE off)", async () => {
      // Admin routes require authentication too — but a missing-bearer 401
      // (vs. 404) is enough to confirm the route is registered.
      const r = await fetch(`${c1Server!.url}/api/admin/skills`);
      expect(r.status).not.toBe(404);
    });

    it("handles 5 concurrent gateway list requests", async () => {
      const headers = { Authorization: `Bearer ${c1Token}` };
      const promises = Array.from({ length: 5 }, () =>
        fetch(`${c1Server!.url}/api/gateway/skills`, { headers }),
      );
      const responses = await Promise.all(promises);
      for (const r of responses) expect(r.status).toBe(200);
    });
  });

  describe("C2: Distributed (Cloud + MCP-only Gateway)", () => {
    it("cloud service is reachable on /api/gateway/health", async () => {
      const r = await fetch(`${c2Cloud!.url}/api/gateway/health`);
      expect(r.status).toBe(200);
    });

    it("gateway exposes /api/gateway/health unauthenticated", async () => {
      const r = await fetch(`${c2Gateway!.url}/api/gateway/health`);
      expect(r.status).toBe(200);
    });

    it("gateway proxies authenticated list requests to cloud", async () => {
      const r = await fetch(`${c2Gateway!.url}/api/gateway/skills`, {
        headers: { Authorization: `Bearer ${c2ClientToken}` },
      });
      expect(r.status).toBe(200);
      const body = await r.json() as { data: Array<{ slug: string }> };
      expect(body.data.find(s => s.slug === "c-test-skill-2")).toBeTruthy();
    });

    it("gateway rejects unauthenticated requests (no anonymous passthrough)", async () => {
      const r = await fetch(`${c2Gateway!.url}/api/gateway/skills`);
      expect(r.status).toBe(401);
    });

    it("both C2 servers stay alive after the suite", () => {
      expect(c2Cloud!.process.exitCode).toBeNull();
      expect(c2Gateway!.process.exitCode).toBeNull();
    });
  });
});
