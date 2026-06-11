import { describe, it, expect, vi } from "vitest";
import { CacheEpochManager } from "@/cache/cache-epochs.js";
import type { CacheEpochRepository } from "@/db/repositories/cache-epoch.repository.js";

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

describe("CacheEpochManager persistence (P0-B)", () => {
  function fakeRepo(initialGlobal = 0, initialUsers: Array<[string, number]> = []) {
    const userMap = new Map<string, number>(initialUsers);
    let g = initialGlobal;
    return {
      loadGlobal: vi.fn(() => g),
      loadAllUsers: vi.fn(() => new Map(userMap)),
      saveGlobal: vi.fn((epoch: number) => { g = epoch; }),
      saveUser: vi.fn((userId: string, epoch: number) => { userMap.set(userId, epoch); }),
      saveUsers: vi.fn((updates: Iterable<[string, number]>) => {
        for (const [u, e] of updates) userMap.set(u, e);
      }),
    } satisfies CacheEpochRepository & Record<string, unknown>;
  }

  it("hydrate() loads persisted global + per-user counters", () => {
    const repo = fakeRepo(5, [["alice", 3], ["bob", 7]]);
    const m = new CacheEpochManager(repo);
    m.hydrate();
    expect(m.getGlobalEpoch()).toBe(5);
    expect(m.getUserEpoch("alice")).toBe(3);
    expect(m.getUserEpoch("bob")).toBe(7);
    expect(m.versionSuffix("alice")).toBe("g5:u3");
  });

  it("hydrate() with no repo is safe (no-op)", () => {
    const m = new CacheEpochManager();
    expect(() => m.hydrate()).not.toThrow();
    expect(m.getGlobalEpoch()).toBe(0);
  });

  it("bumpGlobal writes through to the repo", () => {
    const repo = fakeRepo();
    const m = new CacheEpochManager(repo);
    m.bumpGlobal();
    m.bumpGlobal();
    expect(repo.saveGlobal).toHaveBeenCalledTimes(2);
    expect(repo.saveGlobal).toHaveBeenLastCalledWith(2);
    expect(m.getGlobalEpoch()).toBe(2);
  });

  it("bumpUser writes through to the repo", () => {
    const repo = fakeRepo();
    const m = new CacheEpochManager(repo);
    m.bumpUser("alice");
    expect(repo.saveUser).toHaveBeenCalledWith("alice", 1);
    expect(m.getUserEpoch("alice")).toBe(1);
  });

  it("bumpUsers (batch) prefers saveUsers when repo is configured", () => {
    const repo = fakeRepo();
    const m = new CacheEpochManager(repo);
    m.bumpUsers(["alice", "bob", "carol"]);
    expect(repo.saveUsers).toHaveBeenCalledTimes(1);
    const arg = repo.saveUsers.mock.calls[0][0] as Array<[string, number]>;
    expect(arg).toEqual([["alice", 1], ["bob", 1], ["carol", 1]]);
    // Per-user saveUser should NOT have been called when batching is available.
    expect(repo.saveUser).not.toHaveBeenCalled();
  });

  it("bumpUsers with no repo falls back to per-user bumpUser path", () => {
    const m = new CacheEpochManager();
    m.bumpUsers(["alice", "bob"]);
    expect(m.getUserEpoch("alice")).toBe(1);
    expect(m.getUserEpoch("bob")).toBe(1);
  });

  it("repo failure on bump does not throw — in-memory state still advances", () => {
    const repo = fakeRepo();
    repo.saveGlobal.mockImplementation(() => { throw new Error("disk full"); });
    repo.saveUser.mockImplementation(() => { throw new Error("disk full"); });
    const m = new CacheEpochManager(repo);
    expect(() => m.bumpGlobal()).not.toThrow();
    expect(m.getGlobalEpoch()).toBe(1);
    expect(() => m.bumpUser("alice")).not.toThrow();
    expect(m.getUserEpoch("alice")).toBe(1);
  });

  it("hydrate() repo failure is logged but does not throw", () => {
    const repo = fakeRepo();
    repo.loadGlobal.mockImplementation(() => { throw new Error("io"); });
    const m = new CacheEpochManager(repo);
    expect(() => m.hydrate()).not.toThrow();
    expect(m.getGlobalEpoch()).toBe(0);
  });
});
