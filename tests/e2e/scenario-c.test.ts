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

/** C1: standalone local SQLite + local-fs HTTP Registry. */
describe("Scenario C1: standalone HTTP Registry", () => {
  let testDir: string;
  let server: SpawnedServer;
  let token: string;

  beforeAll(async () => {
    ensureDistBuilt();
    testDir = mkdtempSync(join(tmpdir(), "scenario-c1-"));
    const db = join(testDir, "skill-mcp.db");
    const storage = join(testDir, "data/skills");
    token = seedRbac(db, { tags: ["c1-client"], tokenLabel: "c1-token" }).token;
    writeSkillPackage(storage, "c1-test-skill", "# C1 Test");
    seedPublicSkill(db, "c1-test-skill");
    server = await spawnHttpServer({
      port: await getFreePort(),
      env: { NODE_ENV: "test", DATABASE_PATH: db, STORAGE_BASE_PATH: storage, CACHE_FILE_DIR: join(testDir, "cache") },
    });
  }, 90_000);

  afterAll(async () => {
    await server?.stop();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("exposes /api/health unauthenticated", async () => {
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
  });

  it("requires a bearer token for local gateway reads", async () => {
    expect((await fetch(`${server.url}/api/gateway/skills`)).status).toBe(401);
  });

  it("returns the seeded skill to an authorized gateway caller", async () => {
    const response = await fetch(`${server.url}/api/gateway/skills`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ slug: string }> };
    expect(body.data.some((skill) => skill.slug === "c1-test-skill")).toBe(true);
  });

  it("registers admin routes when MCP-only mode is disabled", async () => {
    expect((await fetch(`${server.url}/api/admin/skills`)).status).not.toBe(404);
  });

  it("handles concurrent authorized gateway reads", async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () =>
      fetch(`${server.url}/api/gateway/skills`, { headers: { Authorization: `Bearer ${token}` } }),
    ));
    for (const response of responses) expect(response.status).toBe(200);
  });
});
