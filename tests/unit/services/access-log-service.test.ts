import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";
import { AccessLogService } from "../../../src/services/access-log.service.js";
import type { AccessLogRepository } from "../../../src/db/repositories/access-log.repository.js";

function fakeLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

describe("AccessLogService", () => {
  it("delegates entries to the repository", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const repo = { create } as unknown as AccessLogRepository;
    const logger = fakeLogger();
    const svc = new AccessLogService(repo, logger);

    await svc.log({
      skillId: "s-1", skillSlug: "demo", action: "view",
      filePaths: ["a.md"], latencyMs: 12, userId: "u-1", sessionId: "sess-1",
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ skillSlug: "demo", action: "view" }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("swallows repo errors so logging never breaks the request path", async () => {
    const create = vi.fn().mockRejectedValue(new Error("disk full"));
    const repo = { create } as unknown as AccessLogRepository;
    const logger = fakeLogger();
    const svc = new AccessLogService(repo, logger);

    // Critically: this must NOT throw — the audit log is best-effort.
    await expect(svc.log({
      skillId: "s-1", skillSlug: "demo", action: "view",
    })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      expect.stringMatching(/Failed to write access log/),
    );
  });
});
