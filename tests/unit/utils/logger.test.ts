import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { createLogger, getLogger, setLogger } from "@/utils/logger.js";

describe("logger", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...origEnv };
  });
  afterEach(() => {
    process.env = origEnv;
  });

  it("createLogger respects an explicit level argument", () => {
    const logger = createLogger("debug");
    expect(logger.level).toBe("debug");
  });

  it("createLogger reads LOG_LEVEL env when no argument is given", () => {
    process.env.LOG_LEVEL = "warn";
    delete process.env.NODE_ENV;
    const logger = createLogger();
    expect(logger.level).toBe("warn");
  });

  it("createLogger defaults to info when env is unset", () => {
    delete process.env.LOG_LEVEL;
    delete process.env.NODE_ENV;
    const logger = createLogger();
    expect(logger.level).toBe("info");
  });

  it("createLogger in production mode does not throw (writes to stderr)", () => {
    process.env.NODE_ENV = "production";
    expect(() => createLogger("error")).not.toThrow();
  });

  it("getLogger returns a singleton", () => {
    setLogger(pino({ level: "fatal" }));
    const a = getLogger();
    const b = getLogger();
    expect(a).toBe(b);
  });

  it("setLogger replaces the singleton", () => {
    const replacement = pino({ level: "trace" });
    setLogger(replacement);
    expect(getLogger()).toBe(replacement);
    expect(getLogger().level).toBe("trace");
  });
});
