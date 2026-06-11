import { describe, it, expect } from "vitest";
import { parseDatabaseUrl, resolveDialect } from "@/db/dialect.js";

describe("parseDatabaseUrl (P0-8)", () => {
  it("treats a bare path as sqlite (legacy DATABASE_PATH)", () => {
    const cfg = parseDatabaseUrl("./data/skill-mcp.db");
    expect(cfg.dialect).toBe("sqlite");
    expect(cfg.path).toBe("./data/skill-mcp.db");
    expect(cfg.url).toBeUndefined();
  });

  it("parses sqlite:///abs/path correctly (three-slash absolute)", () => {
    const cfg = parseDatabaseUrl("sqlite:///var/lib/skill-mcp.db");
    expect(cfg.dialect).toBe("sqlite");
    expect(cfg.path).toBe("/var/lib/skill-mcp.db");
  });

  it("parses sqlite://./relative.db", () => {
    const cfg = parseDatabaseUrl("sqlite://./data/skill-mcp.db");
    expect(cfg.dialect).toBe("sqlite");
    expect(cfg.path).toBe("./data/skill-mcp.db");
  });

  it("parses postgres:// URLs", () => {
    const cfg = parseDatabaseUrl("postgres://user:pw@db.example.com:5432/skillmcp");
    expect(cfg.dialect).toBe("postgres");
    expect(cfg.url).toBe("postgres://user:pw@db.example.com:5432/skillmcp");
    expect(cfg.path).toBeUndefined();
  });

  it("parses postgresql:// URLs equivalently", () => {
    const cfg = parseDatabaseUrl("postgresql://localhost/skill");
    expect(cfg.dialect).toBe("postgres");
  });

  it("rejects unsupported schemes loudly", () => {
    expect(() => parseDatabaseUrl("mysql://localhost/x")).toThrow(/Unsupported database scheme/);
    expect(() => parseDatabaseUrl("mongodb://localhost/x")).toThrow(/Unsupported database scheme/);
  });

  it("rejects empty input", () => {
    expect(() => parseDatabaseUrl("")).toThrow(/empty/);
    expect(() => parseDatabaseUrl("   ")).toThrow(/empty/);
  });
});

describe("resolveDialect (P0-8)", () => {
  it("DATABASE_URL beats DATABASE_PATH when both are set", () => {
    const cfg = resolveDialect({ databaseUrl: "postgres://x/y", databasePath: "./legacy.db" });
    expect(cfg.dialect).toBe("postgres");
  });

  it("falls back to DATABASE_PATH when URL is unset", () => {
    const cfg = resolveDialect({ databasePath: "./data.db" });
    expect(cfg.dialect).toBe("sqlite");
    expect(cfg.path).toBe("./data.db");
  });

  it("throws when neither is set", () => {
    expect(() => resolveDialect({})).toThrow(/Neither DATABASE_URL nor DATABASE_PATH/);
  });

  it("treats empty-string URL as unset (legacy compat)", () => {
    const cfg = resolveDialect({ databaseUrl: "", databasePath: "./data.db" });
    expect(cfg.dialect).toBe("sqlite");
  });
});
