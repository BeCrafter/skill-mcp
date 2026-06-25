import { describe, it, expect, vi } from "vitest";
import { c, truncate, sep, badge, kv, ok, fail, warn, fmtDate, detail, list, infoBox } from "@/cli/ui.js";

describe("cli/ui formatters", () => {
  it("c.* helpers return strings (color may be stripped in non-TTY)", () => {
    expect(typeof c.bold("x")).toBe("string");
    expect(typeof c.boldGreen("x")).toBe("string");
    expect(typeof c.red("x")).toBe("string");
    // Empty string input returns a string (may include ANSI wrapper in TTY).
    expect(typeof c.bold("")).toBe("string");
  });

  it("truncate trims surrounding quotes/whitespace and caps length with ellipsis", () => {
    expect(truncate(`  "hello"  `)).toBe("hello");
    expect(truncate("a".repeat(80), 10)).toBe("a".repeat(9) + "…");
    expect(truncate("short", 70)).toBe("short");
  });

  it("sep returns a separator string of the requested visible length", () => {
    const s = sep(5);
    // Color codes may wrap, but the unicode rule character must appear 5 times.
    expect((s.match(/─/g) || []).length).toBe(5);
  });

  it("badge classifies known statuses", () => {
    expect(badge("published")).toMatch(/published/);
    expect(badge("draft")).toMatch(/draft/);
    expect(badge("archived")).toMatch(/archived/);
  });

  it("kv pads the key column", () => {
    const out = kv("name", "demo", 10);
    // Padding is applied to the dimmed key — at minimum the value must appear after.
    expect(out).toMatch(/demo$/);
    expect(out).toMatch(/name/);
  });

  it("fmtDate formats epoch ms to YYYY-MM-DD HH:MM", () => {
    const out = fmtDate(Date.UTC(2025, 0, 2, 3, 4, 5));
    expect(out).toBe("2025-01-02 03:04");
  });

  it("detail and list shape multi-line output", () => {
    expect(detail("k", "v")).toMatch(/k.*v/);
    expect(list(["a", "b"]).split("\n")).toHaveLength(2);
  });

  it("ok / warn write to stdout, fail writes to stderr", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    ok("done");
    warn("careful");
    fail("boom");
    expect(log).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalledTimes(1);
    log.mockRestore();
    err.mockRestore();
  });

  it("infoBox prints a title and key/value rows to stderr", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    infoBox("Title", [{ key: "a", value: "1" }, { key: "longer", value: "2" }]);
    expect(err).toHaveBeenCalledTimes(3);
    err.mockRestore();
  });

  it("infoBox handles empty items array without crashing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => infoBox("Empty", [])).not.toThrow();
    err.mockRestore();
  });
});
