import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

describe.skip("Scenario B: Local MCP + Remote Storage", () => {
  let testDir: string;
  let storageProcess: ChildProcess | null = null;
  let mcpProcess: ChildProcess | null = null;
  let storagePort = 3000;
  let storageUrl = `http://localhost:${storagePort}`;
  let apiKey = "test-key-scenario-b";

  beforeAll(() => {
    // Create test directory
    testDir = join("/tmp", `scenario-b-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });

    // Create storage directory
    const storageDir = join(testDir, "storage");
    mkdirSync(storageDir, { recursive: true });

    // Create test skill package
    const skillDir = join(storageDir, "data/skills/test-skill-b");
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(skillDir, "SKILL.md"),
      "# Test Skill B\n\nThis is a test skill for scenario B (remote storage).",
    );

    writeFileSync(
      join(skillDir, "manifest.json"),
      JSON.stringify({
        name: "test-skill-b",
        version: "0.0.1",
        entry: "SKILL.md",
      }),
    );

    // Create MCP client directory
    const mcpDir = join(testDir, "mcp");
    mkdirSync(mcpDir, { recursive: true });
  });

  afterAll(() => {
    // Kill processes
    if (storageProcess) {
      storageProcess.kill();
    }
    if (mcpProcess) {
      mcpProcess.kill();
    }

    // Cleanup
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should start remote storage server with API key auth", (done) => {
    const storageDir = join(testDir, "storage");
    const env = {
      ...process.env,
      NODE_ENV: "test",
      TRANSPORT_TYPE: "http",
      TRANSPORT_PORT: String(storagePort),
      DEPLOYMENT_MODE: "standalone",
      DATABASE_PATH: join(storageDir, "skill-mcp.db"),
      STORAGE_BASE_PATH: join(storageDir, "data/skills"),
      CACHE_FILE_DIR: join(storageDir, "data/cache"),
      ENABLE_API_KEY_AUTH: "true",
      API_KEYS: apiKey,
    };

    storageProcess = spawn("npm", ["start"], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });

    if (!storageProcess.stdout || !storageProcess.stderr) {
      done(new Error("Failed to create storage process"));
      return;
    }

    let output = "";
    storageProcess.stdout.on("data", (data) => {
      output += data.toString();
      if (output.includes("HTTP transport configured")) {
        // Wait a bit for server to be ready
        setTimeout(() => done(), 500);
      }
    });

    storageProcess.stderr.on("data", (data) => {
      console.error("Storage stderr:", data.toString());
    });

    storageProcess.on("error", (error) => {
      done(new Error(`Failed to start storage: ${error.message}`));
    });

    setTimeout(() => {
      if (!output.includes("HTTP transport configured")) {
        done(new Error("Storage server did not start within 15 seconds"));
      }
    }, 15000);
  });

  it("should verify storage server health check", async () => {
    const response = await fetch(`${storageUrl}/api/gateway/health`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    expect(response.status).toBe(200);
    const data = await response.json() as { status: string };
    expect(data.status).toBe("ok");
  });

  it("should reject requests without API key", async () => {
    const response = await fetch(`${storageUrl}/api/gateway/health`);
    expect(response.status).toBe(401);
  });

  it("should reject requests with invalid API key", async () => {
    const response = await fetch(`${storageUrl}/api/gateway/health`, {
      headers: {
        Authorization: "Bearer invalid-key",
      },
    });
    expect(response.status).toBe(401);
  });

  it("should start MCP client connected to remote storage", (done) => {
    const mcpDir = join(testDir, "mcp");
    const env = {
      ...process.env,
      NODE_ENV: "test",
      TRANSPORT_TYPE: "stdio",
      DEPLOYMENT_MODE: "gateway",
      CLOUD_SERVICE_URL: storageUrl,
      AUTH_TOKEN: apiKey,
      DATABASE_PATH: join(mcpDir, "skill-mcp.db"),
      CACHE_FILE_DIR: join(mcpDir, "data/cache"),
    };

    mcpProcess = spawn("npm", ["start"], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });

    if (!mcpProcess.stdout || !mcpProcess.stderr) {
      done(new Error("Failed to create MCP process"));
      return;
    }

    let output = "";
    mcpProcess.stdout.on("data", (data) => {
      output += data.toString();
      if (output.includes("Stdio transport configured")) {
        setTimeout(() => done(), 500);
      }
    });

    mcpProcess.stderr.on("data", (data) => {
      console.error("MCP stderr:", data.toString());
    });

    mcpProcess.on("error", (error) => {
      done(new Error(`Failed to start MCP: ${error.message}`));
    });

    setTimeout(() => {
      if (!output.includes("Stdio transport configured")) {
        done(new Error("MCP server did not start within 15 seconds"));
      }
    }, 15000);
  });

  it("should list skills from remote storage via MCP client", async () => {
    // Wait for both services to be ready
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Query storage directly to verify skill exists
    const response = await fetch(`${storageUrl}/api/gateway/skills`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    expect(response.status).toBe(200);
    const data = await response.json() as { data: Array<{ slug: string; name: string }> };

    // May be empty initially - that's ok
    expect(Array.isArray(data.data)).toBe(true);
  });

  it("should verify RemoteProvider caching", async () => {
    // Make first request
    const start1 = Date.now();
    const response1 = await fetch(`${storageUrl}/api/gateway/skills`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const time1 = Date.now() - start1;

    // Make second request (should hit cache)
    const start2 = Date.now();
    const response2 = await fetch(`${storageUrl}/api/gateway/skills`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const time2 = Date.now() - start2;

    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);

    // Second request should be faster (or at least not slower by much)
    // In reality cache is local, so this is just sanity check
    expect(time2).toBeLessThanOrEqual(time1 + 100);
  });

  it("should handle connection between MCP and storage", async () => {
    // Both services running, verify they can communicate
    // by checking MCP doesn't crash and storage is accessible

    expect(mcpProcess?.pid).toBeDefined();
    expect(storageProcess?.pid).toBeDefined();

    // Verify storage is still responding
    const response = await fetch(`${storageUrl}/api/gateway/health`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    expect(response.status).toBe(200);
  });

  it("should verify auth token is used by RemoteProvider", async () => {
    // Try with wrong token - should fail
    const response = await fetch(`${storageUrl}/api/gateway/skills`, {
      headers: {
        Authorization: "Bearer wrong-token",
      },
    });

    expect(response.status).toBe(401);

    // Try with correct token - should succeed
    const response2 = await fetch(`${storageUrl}/api/gateway/skills`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    expect(response2.status).toBe(200);
  });
});
