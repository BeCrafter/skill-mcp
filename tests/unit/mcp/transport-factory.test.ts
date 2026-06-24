import { describe, it, expect, vi } from "vitest";
import { parseTransportType } from "@/mcp/transport/index.js";

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
