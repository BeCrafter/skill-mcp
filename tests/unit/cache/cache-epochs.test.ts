import { describe, it, expect } from "vitest";
import { CacheEpochManager } from "@/cache/cache-epochs.js";

describe("CacheEpochManager (T-102)", () => {
  it("starts every user at epoch 0", () => {
    const m = new CacheEpochManager();
    expect(m.getUserEpoch("alice")).toBe(0);
    expect(m.getGlobalEpoch()).toBe(0);
    expect(m.versionSuffix("alice")).toBe("g0:u0");
  });

  it("bumpUser only affects the named user", () => {
    const m = new CacheEpochManager();
    m.bumpUser("alice");
    expect(m.getUserEpoch("alice")).toBe(1);
    expect(m.getUserEpoch("bob")).toBe(0);
    expect(m.versionSuffix("alice")).toBe("g0:u1");
    expect(m.versionSuffix("bob")).toBe("g0:u0");
  });

  it("bumpUsers handles iterables", () => {
    const m = new CacheEpochManager();
    m.bumpUsers(["alice", "bob"]);
    m.bumpUsers(new Set(["alice"]));
    expect(m.getUserEpoch("alice")).toBe(2);
    expect(m.getUserEpoch("bob")).toBe(1);
  });

  it("bumpGlobal changes everyone's effective version", () => {
    const m = new CacheEpochManager();
    m.bumpGlobal();
    expect(m.getGlobalEpoch()).toBe(1);
    expect(m.versionSuffix("anonymous")).toBe("g1:u0");
    expect(m.versionSuffix("alice")).toBe("g1:u0");
  });

  it("global and user epochs compose independently", () => {
    const m = new CacheEpochManager();
    m.bumpGlobal();
    m.bumpUser("alice");
    expect(m.versionSuffix("alice")).toBe("g1:u1");
    expect(m.versionSuffix("bob")).toBe("g1:u0");
  });
});
