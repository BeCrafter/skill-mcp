import { describe, it, expect } from "vitest";
import { generateId, shortId, generateToken, isLegacyUuid, generateUniqueId } from "@/utils/id.js";

describe("generateId", () => {
  it("returns prefixed id with default length", () => {
    const id = generateId("skl_");
    expect(id).toMatch(/^skl_[a-z0-9]{16}$/);
  });

  it("returns prefixed id with custom size", () => {
    const id = generateId("usr_", 12);
    expect(id).toMatch(/^usr_[a-z0-9]{12}$/);
  });
});

describe("shortId", () => {
  it("returns id with default length 21", () => {
    const id = shortId();
    expect(id).toMatch(/^[a-z0-9]{21}$/);
  });

  it("returns id with custom size", () => {
    const id = shortId(10);
    expect(id).toMatch(/^[a-z0-9]{10}$/);
  });
});

describe("generateToken", () => {
  it("returns sk-live- prefixed token", () => {
    const token = generateToken();
    expect(token).toMatch(/^sk-live-[a-z0-9]{24}$/);
  });
});

describe("isLegacyUuid", () => {
  it("matches UUID v4 format", () => {
    expect(isLegacyUuid("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d")).toBe(true);
    expect(isLegacyUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("rejects non-UUID strings", () => {
    expect(isLegacyUuid("skl_VGhpcyBpcyBhbi")).toBe(false);
    expect(isLegacyUuid("my-cool-skill")).toBe(false);
    expect(isLegacyUuid("550e8400e29b41d4a716446655440000")).toBe(false); // no hyphens
    expect(isLegacyUuid("")).toBe(false);
  });
});

describe("uniqueness", () => {
  it("generates 10000 unique prefixed ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) ids.add(generateId("skl_"));
    expect(ids.size).toBe(10000);
  });

  it("generates 10000 unique short ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) ids.add(shortId());
    expect(ids.size).toBe(10000);
  });

  it("generates 10000 unique tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 10000; i++) tokens.add(generateToken());
    expect(tokens.size).toBe(10000);
  });
});

describe("generateUniqueId", () => {
  it("returns id on first try when no collision", async () => {
    const exists = async () => false;
    const id = await generateUniqueId(() => generateId("skl_"), exists);
    expect(id).toMatch(/^skl_[a-z0-9]{16}$/);
  });

  it("retries on collision and succeeds", async () => {
    let callCount = 0;
    const exists = async () => {
      callCount++;
      return callCount <= 2; // first 2 collide, 3rd succeeds
    };
    const id = await generateUniqueId(() => generateId("skl_"), exists);
    expect(id).toMatch(/^skl_[a-z0-9]{16}$/);
    expect(callCount).toBe(3);
  });

  it("throws after 5 consecutive collisions", async () => {
    const exists = async () => true; // always collides
    await expect(
      generateUniqueId(() => generateId("skl_"), exists),
    ).rejects.toThrow("Failed to generate unique ID after 5 attempts");
  });
});
