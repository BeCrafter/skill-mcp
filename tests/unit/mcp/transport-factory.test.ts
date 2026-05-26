import { describe, it, expect, vi } from "vitest";
import { parseTransportType, createTransport } from "@/mcp/transport/index.js";

describe("parseTransportType", () => {
  it("defaults to stdio when undefined", () => {
    expect(parseTransportType(undefined)).toBe("stdio");
  });

  it("accepts the three known transport names", () => {
    expect(parseTransportType("stdio")).toBe("stdio");
    expect(parseTransportType("sse")).toBe("sse");
    expect(parseTransportType("http")).toBe("http");
  });

  it("falls back to stdio with a warning on unknown input", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseTransportType("ws")).toBe("stdio");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("createTransport", () => {
  it("creates a stdio transport", () => {
    const t = createTransport({ type: "stdio" });
    expect(t.type).toBe("stdio");
    expect(t.transport).toBeDefined();
  });

  it("rejects unsupported types (sse / http live in app.ts)", () => {
    expect(() => createTransport({ type: "http" } as never)).toThrow(/only supports stdio/);
    expect(() => createTransport({ type: "sse" } as never)).toThrow(/only supports stdio/);
  });
});
