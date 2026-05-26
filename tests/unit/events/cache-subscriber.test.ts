import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupCacheSubscribers } from "@/events/cache-subscriber.js";
import { DomainEventBus } from "@/events/event-bus.js";
import { CacheEpochManager } from "@/cache/cache-epochs.js";
import type { ICacheProvider } from "@/cache/provider.interface.js";
import type { RoleRepository, RoleEntity } from "@/db/repositories/role.repository.js";
import type { UserRoleRepository } from "@/db/repositories/user-role.repository.js";

function makeCache(): ICacheProvider {
  return {
    get: vi.fn(async () => null),
    getWithMeta: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    has: vi.fn(async () => false),
    delete: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    clearByPrefix: vi.fn(async () => {}),
  };
}

function makeRoleRepo(roles: RoleEntity[]): RoleRepository {
  return {
    findAll: async () => roles,
    findById: async () => null,
    findByName: async () => null,
    findByIds: async () => [],
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as RoleRepository;
}

function makeUserRoleRepo(roleToUsers: Record<string, string[]>): UserRoleRepository {
  return {
    findUserIdsByRoleId: async (rid: string) => roleToUsers[rid] ?? [],
    findUserIdsByRoleIds: async (rids: string[]) => {
      const out = new Set<string>();
      for (const rid of rids) (roleToUsers[rid] ?? []).forEach((u) => out.add(u));
      return [...out];
    },
    findRoleIdsByUserId: async () => [],
    findByUserId: async () => [],
    getAggregatedTagsByUserId: async () => [],
    replaceUserRoles: vi.fn(),
    deleteByUserId: vi.fn(),
    deleteByRoleId: vi.fn(),
  } as unknown as UserRoleRepository;
}

describe("setupCacheSubscribers (T-102)", () => {
  let bus: DomainEventBus;
  let cache: ICacheProvider;
  let epochs: CacheEpochManager;

  beforeEach(() => {
    bus = new DomainEventBus();
    cache = makeCache();
    epochs = new CacheEpochManager();
  });

  it("clears entry/file caches on any skill mutation", () => {
    setupCacheSubscribers(bus, cache, epochs);
    bus.publish({ type: "skill:updated", slug: "demo", visibility: "public", tags: [] });
    expect(cache.clearByPrefix).toHaveBeenCalledWith("skill:entry:demo");
    expect(cache.clearByPrefix).toHaveBeenCalledWith("skill:file:demo");
  });

  it("public skill mutation bumps the global epoch (affects everyone)", () => {
    setupCacheSubscribers(bus, cache, epochs);
    const before = epochs.getGlobalEpoch();
    bus.publish({ type: "skill:updated", slug: "demo", visibility: "public", tags: ["red"] });
    expect(epochs.getGlobalEpoch()).toBe(before + 1);
  });

  it("private+empty-tags skill mutation bumps the global epoch", () => {
    setupCacheSubscribers(bus, cache, epochs);
    bus.publish({ type: "skill:created", slug: "demo", visibility: "private", tags: [] });
    expect(epochs.getGlobalEpoch()).toBe(1);
  });

  it("private+tagged skill mutation only bumps users whose roles intersect tags", async () => {
    const roleA: RoleEntity = { id: "role-A", name: "team-red", description: null, tags: ["red"], createdAt: 0, updatedAt: 0 };
    const roleB: RoleEntity = { id: "role-B", name: "team-blue", description: null, tags: ["blue"], createdAt: 0, updatedAt: 0 };
    const roleRepo = makeRoleRepo([roleA, roleB]);
    const userRoleRepo = makeUserRoleRepo({ "role-A": ["alice"], "role-B": ["bob"] });

    setupCacheSubscribers(bus, cache, epochs, { roleRepo, userRoleRepo });

    bus.publish({ type: "skill:updated", slug: "secret", visibility: "private", tags: ["red"] });
    // Domain event handlers run synchronously but may resolve async work; flush microtasks.
    await new Promise((r) => setImmediate(r));

    expect(epochs.getUserEpoch("alice")).toBe(1); // A had matching tags
    expect(epochs.getUserEpoch("bob")).toBe(0); // B did NOT — cache stays valid
    expect(epochs.getGlobalEpoch()).toBe(0);
  });

  it("falls back to global bump when visibility is missing (back-compat)", () => {
    setupCacheSubscribers(bus, cache, epochs);
    bus.publish({ type: "skill:imported", slug: "demo" });
    expect(epochs.getGlobalEpoch()).toBe(1);
  });

  it("falls back to global bump when role/userRole repos are unavailable", () => {
    setupCacheSubscribers(bus, cache, epochs);
    bus.publish({ type: "skill:updated", slug: "demo", visibility: "private", tags: ["red"] });
    expect(epochs.getGlobalEpoch()).toBe(1);
  });

  it("user:roles_changed bumps just that user", () => {
    setupCacheSubscribers(bus, cache, epochs);
    bus.publish({ type: "user:roles_changed", userId: "alice" });
    expect(epochs.getUserEpoch("alice")).toBe(1);
    expect(epochs.getUserEpoch("bob")).toBe(0);
    expect(epochs.getGlobalEpoch()).toBe(0);
  });

  it("uses batched findUserIdsByRoleIds (T-503) instead of N per-role calls", async () => {
    const roleA: RoleEntity = { id: "role-A", name: "team-red", description: null, tags: ["red"], createdAt: 0, updatedAt: 0 };
    const roleB: RoleEntity = { id: "role-B", name: "team-red-2", description: null, tags: ["red"], createdAt: 0, updatedAt: 0 };
    const roleC: RoleEntity = { id: "role-C", name: "team-blue", description: null, tags: ["blue"], createdAt: 0, updatedAt: 0 };
    const roleRepo = makeRoleRepo([roleA, roleB, roleC]);
    const batchSpy = vi.fn(async (rids: string[]) => {
      const map: Record<string, string[]> = { "role-A": ["alice"], "role-B": ["bob"], "role-C": ["carol"] };
      const out = new Set<string>();
      for (const r of rids) (map[r] ?? []).forEach((u) => out.add(u));
      return [...out];
    });
    const perRoleSpy = vi.fn(async () => [] as string[]);
    const userRoleRepo = {
      findUserIdsByRoleId: perRoleSpy,
      findUserIdsByRoleIds: batchSpy,
      findRoleIdsByUserId: async () => [],
      findByUserId: async () => [],
      getAggregatedTagsByUserId: async () => [],
      replaceUserRoles: vi.fn(),
      deleteByUserId: vi.fn(),
      deleteByRoleId: vi.fn(),
    } as unknown as UserRoleRepository;

    setupCacheSubscribers(bus, cache, epochs, { roleRepo, userRoleRepo });
    bus.publish({ type: "skill:updated", slug: "secret", visibility: "private", tags: ["red"] });
    await new Promise((r) => setImmediate(r));

    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy).toHaveBeenCalledWith(["role-A", "role-B"]);
    expect(perRoleSpy).not.toHaveBeenCalled();
    expect(epochs.getUserEpoch("alice")).toBe(1);
    expect(epochs.getUserEpoch("bob")).toBe(1);
    expect(epochs.getUserEpoch("carol")).toBe(0);
  });

  it("role:updated bumps every affected user", () => {
    setupCacheSubscribers(bus, cache, epochs);
    bus.publish({ type: "role:updated", roleId: "role-A", affectedUserIds: ["alice", "bob"] });
    expect(epochs.getUserEpoch("alice")).toBe(1);
    expect(epochs.getUserEpoch("bob")).toBe(1);
  });

  it("T-720: a rejecting clearByPrefix does not surface as unhandledRejection and the epoch bump still runs", async () => {
    const failingCache: ICacheProvider = {
      ...makeCache(),
      clearByPrefix: vi.fn(async () => { throw new Error("file cache I/O kaboom"); }),
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      setupCacheSubscribers(bus, failingCache, epochs);
      bus.publish({ type: "skill:updated", slug: "demo", visibility: "public", tags: [] });
      // Wait two macrotask turns so both rejected promises have a chance to surface.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
      // Despite the cache failure, the epoch bump for a public skill must still run.
      expect(epochs.getGlobalEpoch()).toBe(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
