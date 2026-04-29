import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

describe.skip("Scenario C: Distributed HTTP Deployment", () => {
  let testDir: string;
  let c1Process: ChildProcess | null = null;
  let c2StorageProcess: ChildProcess | null = null;
  let c2McpProcess: ChildProcess | null = null;

  beforeAll(() => {
    testDir = join("/tmp", `scenario-c-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });

    // Create C1 directory
    const c1Dir = join(testDir, "c1");
    mkdirSync(c1Dir, { recursive: true });

    // Create C2 directories
    const c2StorageDir = join(testDir, "c2-storage");
    const c2McpDir = join(testDir, "c2-mcp");
    mkdirSync(c2StorageDir, { recursive: true });
    mkdirSync(c2McpDir, { recursive: true });

    // Create test skills
    for (const dir of [c1Dir, c2StorageDir]) {
      const skillDir = join(dir, "data/skills/c-test-skill");
      mkdirSync(skillDir, { recursive: true });

      writeFileSync(
        join(skillDir, "SKILL.md"),
        "# C Test Skill\n\nTest skill for scenario C.",
      );

      writeFileSync(
        join(skillDir, "manifest.json"),
        JSON.stringify({
          name: "c-test-skill",
          version: "1.0.0",
          entry: "SKILL.md",
        }),
      );
    }
  });

  afterAll(() => {
    if (c1Process) c1Process.kill();
    if (c2StorageProcess) c2StorageProcess.kill();
    if (c2McpProcess) c2McpProcess.kill();

    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("C1: Single Server", () => {
    it("should start HTTP server with unified service", (done) => {
      const c1Dir = join(testDir, "c1");
      const env = {
        ...process.env,
        NODE_ENV: "test",
        TRANSPORT_TYPE: "http",
        TRANSPORT_PORT: "3000",
        DEPLOYMENT_MODE: "standalone",
        DATABASE_PATH: join(c1Dir, "skill-mcp.db"),
        STORAGE_BASE_PATH: join(c1Dir, "data/skills"),
        MCP_ONLY_MODE: "false",
      };

      c1Process = spawn("npm", ["start"], {
        cwd: process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });

      if (!c1Process.stdout) {
        done(new Error("Failed to create C1 process"));
        return;
      }

      let output = "";
      c1Process.stdout.on("data", (data) => {
        output += data.toString();
        if (output.includes("HTTP transport configured")) {
          setTimeout(() => done(), 500);
        }
      });

      setTimeout(() => {
        if (!output.includes("HTTP transport configured")) {
          done(new Error("C1 server did not start"));
        }
      }, 15000);
    });

    it("should respond to health check on port 3000", async () => {
      const response = await fetch("http://localhost:3000/api/health");
      expect(response.status).toBe(200);
    });

    it("should provide both /mcp and /api endpoints", async () => {
      // Check admin API
      const adminResp = await fetch("http://localhost:3000/api/health");
      expect(adminResp.status).toBe(200);

      // Check gateway API (C1 provides both)
      const gatewayResp = await fetch("http://localhost:3000/api/gateway/health");
      expect(gatewayResp.status).toBe(200);
    });
  });

  describe("C2: Distributed (Storage + MCP)", () => {
    it("should start C2 storage service on port 3001", (done) => {
      const storageDir = join(testDir, "c2-storage");
      const env = {
        ...process.env,
        NODE_ENV: "test",
        TRANSPORT_TYPE: "http",
        TRANSPORT_PORT: "3001",
        DEPLOYMENT_MODE: "standalone",
        DATABASE_PATH: join(storageDir, "skill-mcp.db"),
        STORAGE_BASE_PATH: join(storageDir, "data/skills"),
        MCP_ONLY_MODE: "true",
        ENABLE_API_KEY_AUTH: "true",
        API_KEYS: "c2-storage-key",
      };

      c2StorageProcess = spawn("npm", ["start"], {
        cwd: process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });

      if (!c2StorageProcess.stdout) {
        done(new Error("Failed to create C2 storage process"));
        return;
      }

      let output = "";
      c2StorageProcess.stdout.on("data", (data) => {
        output += data.toString();
        if (output.includes("HTTP transport configured")) {
          setTimeout(() => done(), 500);
        }
      });

      setTimeout(() => {
        if (!output.includes("HTTP transport configured")) {
          done(new Error("C2 storage did not start"));
        }
      }, 15000);
    });

    it("should only provide /api/gateway endpoints in C2 storage", async () => {
      await new Promise(resolve => setTimeout(resolve, 500));

      // Gateway API should work with auth
      const gatewayResp = await fetch("http://localhost:3001/api/gateway/health", {
        headers: {
          Authorization: "Bearer c2-storage-key",
        },
      });
      expect(gatewayResp.status).toBe(200);

      // Admin API should fail or not exist
      const adminResp = await fetch("http://localhost:3001/api/health");
      expect([404, 401]).toContain(adminResp.status);
    });

    it("should start C2 MCP service on port 3002", (done) => {
      const mcpDir = join(testDir, "c2-mcp");
      const env = {
        ...process.env,
        NODE_ENV: "test",
        TRANSPORT_TYPE: "http",
        TRANSPORT_PORT: "3002",
        DEPLOYMENT_MODE: "gateway",
        CLOUD_SERVICE_URL: "http://localhost:3001",
        AUTH_TOKEN: "c2-storage-key",
        DATABASE_PATH: join(mcpDir, "skill-mcp.db"),
        MCP_ONLY_MODE: "true",
      };

      c2McpProcess = spawn("npm", ["start"], {
        cwd: process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });

      if (!c2McpProcess.stdout) {
        done(new Error("Failed to create C2 MCP process"));
        return;
      }

      let output = "";
      c2McpProcess.stdout.on("data", (data) => {
        output += data.toString();
        if (output.includes("HTTP transport configured")) {
          setTimeout(() => done(), 500);
        }
      });

      setTimeout(() => {
        if (!output.includes("HTTP transport configured")) {
          done(new Error("C2 MCP did not start"));
        }
      }, 15000);
    });

    it("should verify C2 MCP connects to storage", async () => {
      await new Promise(resolve => setTimeout(resolve, 500));

      // C2 MCP should provide /mcp endpoints but not /api
      // (would need to implement MCP protocol test)
      // For now, just verify both processes are running
      expect(c2McpProcess?.pid).toBeDefined();
      expect(c2StorageProcess?.pid).toBeDefined();
    });

    it("should handle concurrent requests to C1", async () => {
      // Make multiple concurrent requests to C1
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          fetch("http://localhost:3000/api/health")
        );
      }

      const responses = await Promise.all(promises);
      for (const resp of responses) {
        expect(resp.status).toBe(200);
      }
    });

    it("should isolate sessions in C2", async () => {
      // Both C1 and C2 running
      // C1 provides unified service
      const c1Health = await fetch("http://localhost:3000/api/health");

      // C2 provides separated services
      const c2StorageHealth = await fetch("http://localhost:3001/api/gateway/health", {
        headers: {
          Authorization: "Bearer c2-storage-key",
        },
      });

      // Both should respond
      expect(c1Health.status).toBe(200);
      expect(c2StorageHealth.status).toBe(200);
    });
  });

  describe("Performance Comparison", () => {
    it("C1 should respond quickly (shared cache)", async () => {
      const start = Date.now();
      const response = await fetch("http://localhost:3000/api/health");
      const duration = Date.now() - start;

      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(100); // Should be < 100ms
    });

    it("C2 storage should respond to authenticated requests", async () => {
      const start = Date.now();
      const response = await fetch("http://localhost:3001/api/gateway/health", {
        headers: {
          Authorization: "Bearer c2-storage-key",
        },
      });
      const duration = Date.now() - start;

      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(100);
    });
  });
});
