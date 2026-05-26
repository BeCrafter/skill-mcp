import { describe, it, expect, beforeEach } from "vitest";
import { createConfig, getDefaultDataDir } from "@/config/index.js";
import { homedir } from "node:os";
import { join } from "node:path";

describe("Configuration Default Paths", () => {
  beforeEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.STORAGE_BASE_PATH;
    delete process.env.CACHE_FILE_DIR;
  });

  it("should use user home directory for default data path", () => {
    const defaultDir = getDefaultDataDir();
    expect(defaultDir).toBe(join(homedir(), ".skill-mcp"));
  });

  it("should use user home based paths by default", () => {
    const config = createConfig();
    const userHome = homedir();

    expect(config.database.path).toBe(join(userHome, ".skill-mcp", "skill-mcp.db"));
    expect(config.storage.basePath).toBe(join(userHome, ".skill-mcp", "data", "skills"));
    expect(config.cache.file.cacheDir).toBe(join(userHome, ".skill-mcp", "cache"));
  });

  it("should allow environment variable override for database path", () => {
    process.env.DATABASE_PATH = "/tmp/custom.db";
    const config = createConfig();
    expect(config.database.path).toBe("/tmp/custom.db");
  });

  it("should allow environment variable override for storage path", () => {
    process.env.STORAGE_BASE_PATH = "/tmp/skills";
    const config = createConfig();
    expect(config.storage.basePath).toBe("/tmp/skills");
  });

  it("should allow environment variable override for cache directory", () => {
    process.env.CACHE_FILE_DIR = "/tmp/cache";
    const config = createConfig();
    expect(config.cache.file.cacheDir).toBe("/tmp/cache");
  });

  it("should respect all custom paths when set via environment", () => {
    process.env.DATABASE_PATH = "/tmp/test.db";
    process.env.STORAGE_BASE_PATH = "/tmp/test-skills";
    process.env.CACHE_FILE_DIR = "/tmp/test-cache";

    const config = createConfig();
    expect(config.database.path).toBe("/tmp/test.db");
    expect(config.storage.basePath).toBe("/tmp/test-skills");
    expect(config.cache.file.cacheDir).toBe("/tmp/test-cache");
  });
});
