import { describe, it, expect, vi } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { attachRequestId } from "../../../src/http/middleware/request-id.js";

function makePair(headers: Record<string, string> = {}) {
  const req = new IncomingMessage(new Socket());
  Object.assign(req.headers, headers);
  const res = new ServerResponse(req);
  return { req, res };
}

describe("attachRequestId", () => {
  it("preserves the inbound X-Request-ID and echoes it on the response", () => {
    const { req, res } = makePair({ "x-request-id": "abc-123" });
    const id = attachRequestId(req, res);
    expect(id).toBe("abc-123");
    expect(res.getHeader("X-Request-ID")).toBe("abc-123");
  });

  it("generates a UUID when no header is supplied", () => {
    const { req, res } = makePair();
    const id = attachRequestId(req, res);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.getHeader("X-Request-ID")).toBe(id);
  });

  it("each call without a header gets a fresh id", () => {
    const a = attachRequestId(makePair().req, makePair().res);
    const b = attachRequestId(makePair().req, makePair().res);
    expect(a).not.toBe(b);
  });

  it("does not mutate other headers", () => {
    const { req, res } = makePair({ "x-request-id": "fixed" });
    const setHeader = vi.spyOn(res, "setHeader");
    attachRequestId(req, res);
    expect(setHeader).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith("X-Request-ID", "fixed");
  });
});
