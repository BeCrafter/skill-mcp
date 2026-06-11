import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillService } from "@/services/skill.service.js";
import { ConfigurationError, SkillNotFoundError } from "@/utils/errors.js";

// P0-A — service-level coverage for the admin convergence layer (review §4.1).
// These tests assert each admin* method's contract: delegation correctness,
// event publication, ADMIN_PUT_ALLOWED projection, the storage-before-DB
// delete order, and the ConfigurationError fallback when admin deps are absent.

const SKILL_ROW = {
  id: "s1", slug: "demo", name: "demo", displayName: null, description: "",
  version: "0.0.1", category: null, tags: ["x"], attributes: {},
  status: "draft" as const, visibility: "private" as const, entryFile: "SKILL.md",
  storagePath: "demo/", contentHash: "h", createdAt: 1, updatedAt: 1,
};

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

function makeService(opts: {
  skillRepo?: unknown;
  storage?: unknown;
  skillProvider?: unknown;
  versionRepo?: unknown;
  eventBus?: unknown;
  importer?: unknown;
  accessLogRepo?: unknown;
} = {}) {
  return new SkillService(
    (opts.skillProvider ?? {}) as never,
    {} as never,
    makeLogger(),
    {} as never,
    {} as never,
    (opts.versionRepo ?? {}) as never,
    (opts.skillRepo ?? null) as never,
    (opts.storage ?? null) as never,
    undefined,
    undefined,
    {
      eventBus: opts.eventBus as never,
      importer: opts.importer as never,
      accessLogRepo: opts.accessLogRepo as never,
    },
  );
}

describe("SkillService — admin convergence (P0-A)", () => {
  describe("adminUpdateSkill", () => {
    let skillRepo: { findBySlug: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    let eventBus: { publish: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      skillRepo = {
        findBySlug: vi.fn().mockResolvedValue(SKILL_ROW),
        update: vi.fn().mockResolvedValue({ ...SKILL_ROW, description: "new" }),
      };
      eventBus = { publish: vi.fn() };
    });

    it("projects body to ADMIN_PUT_ALLOWED and strips storagePath / contentHash", async () => {
      const svc = makeService({ skillRepo, eventBus });
      await svc.adminUpdateSkill("demo", {
        description: "new", tags: ["x"], displayName: "D",
        storagePath: "../etc/passwd/", contentHash: "tampered",
        bogusField: "ignored",
      });
      const projected = skillRepo.update.mock.calls[0][1];
      expect(projected).toEqual({ description: "new", tags: ["x"], displayName: "D" });
    });

    it("publishes skill:updated with post-update visibility/tags", async () => {
      skillRepo.update.mockResolvedValue({ ...SKILL_ROW, visibility: "public", tags: ["y"] });
      const svc = makeService({ skillRepo, eventBus });
      await svc.adminUpdateSkill("demo", { visibility: "public", tags: ["y"] });
      expect(eventBus.publish).toHaveBeenCalledWith({
        type: "skill:updated", slug: "demo", visibility: "public", tags: ["y"],
      });
    });

    it("throws SkillNotFoundError when slug missing", async () => {
      skillRepo.findBySlug.mockResolvedValue(null);
      const svc = makeService({ skillRepo, eventBus });
      await expect(svc.adminUpdateSkill("ghost", { description: "x" }))
        .rejects.toBeInstanceOf(SkillNotFoundError);
    });

    it("throws ConfigurationError when skillRepo not wired", async () => {
      const svc = makeService({ eventBus });
      await expect(svc.adminUpdateSkill("demo", {})).rejects.toBeInstanceOf(ConfigurationError);
    });
  });

  describe("adminDeleteSkill", () => {
    it("deletes storage BEFORE the DB row (live tree removed before metadata)", async () => {
      const order: string[] = [];
      const skillRepo = {
        findBySlug: vi.fn().mockResolvedValue(SKILL_ROW),
        delete: vi.fn(async () => { order.push("repo.delete"); return true; }),
      };
      const storage = {
        deleteDir: vi.fn(async () => { order.push("storage.deleteDir"); }),
      };
      const eventBus = { publish: vi.fn() };
      const svc = makeService({ skillRepo, storage, eventBus });
      await svc.adminDeleteSkill("demo");
      expect(order).toEqual(["storage.deleteDir", "repo.delete"]);
      expect(storage.deleteDir).toHaveBeenCalledWith("demo/");
      expect(eventBus.publish).toHaveBeenCalledWith({
        type: "skill:deleted", slug: "demo", visibility: "private", tags: ["x"],
      });
    });

    it("throws SkillNotFoundError when slug missing", async () => {
      const skillRepo = { findBySlug: vi.fn().mockResolvedValue(null), delete: vi.fn() };
      const storage = { deleteDir: vi.fn() };
      const svc = makeService({ skillRepo, storage, eventBus: { publish: vi.fn() } });
      await expect(svc.adminDeleteSkill("ghost")).rejects.toBeInstanceOf(SkillNotFoundError);
      expect(storage.deleteDir).not.toHaveBeenCalled();
    });

    it("throws ConfigurationError when storage not wired", async () => {
      const skillRepo = { findBySlug: vi.fn().mockResolvedValue(SKILL_ROW) };
      const svc = makeService({ skillRepo });
      await expect(svc.adminDeleteSkill("demo")).rejects.toBeInstanceOf(ConfigurationError);
    });
  });

  describe("adminListSkills / adminFindSkillsByName / adminGetSkillBySlug", () => {
    it("adminListSkills forwards filter opts to repo.findAll and returns DTOs", async () => {
      const skillRepo = {
        findAll: vi.fn().mockResolvedValue([SKILL_ROW]),
      };
      const svc = makeService({ skillRepo });
      const out = await svc.adminListSkills({ category: "ai", tags: ["t"], attributes: { lang: "zh" } });
      expect(skillRepo.findAll).toHaveBeenCalledWith({
        category: "ai", tags: ["t"], attributes: { lang: "zh" },
      });
      expect(out[0]).not.toHaveProperty("storagePath");
      expect(out[0]).not.toHaveProperty("contentHash");
    });

    it("adminFindSkillsByName forwards to repo.findByName", async () => {
      const skillRepo = { findByName: vi.fn().mockResolvedValue([SKILL_ROW]) };
      const svc = makeService({ skillRepo });
      await svc.adminFindSkillsByName("demo");
      expect(skillRepo.findByName).toHaveBeenCalledWith("demo");
    });

    it("adminGetSkillBySlug throws SkillNotFoundError on miss", async () => {
      const skillRepo = { findBySlug: vi.fn().mockResolvedValue(null) };
      const svc = makeService({ skillRepo });
      await expect(svc.adminGetSkillBySlug("ghost")).rejects.toBeInstanceOf(SkillNotFoundError);
    });
  });

  describe("adminGetEntry / adminGetFiles / adminGetFileTree", () => {
    it("delegates to skillProvider without permission filter", async () => {
      const skillProvider = {
        getSkillEntry: vi.fn().mockResolvedValue("# entry"),
        getSkillFiles: vi.fn().mockResolvedValue([{ filePath: "a.md", content: "x" }]),
        getSkillFileTree: vi.fn().mockResolvedValue([{ filePath: "a.md" }]),
      };
      const svc = makeService({ skillProvider });
      expect(await svc.adminGetEntry("demo")).toBe("# entry");
      await svc.adminGetFiles("demo", ["a.md"]);
      expect(skillProvider.getSkillFiles).toHaveBeenCalledWith("demo", ["a.md"]);
      await svc.adminGetFileTree("demo");
      expect(skillProvider.getSkillFileTree).toHaveBeenCalledWith("demo");
    });
  });

  describe("adminCountSkills / adminFindAccessLogs", () => {
    it("adminCountSkills returns repo.count()", async () => {
      const skillRepo = { count: vi.fn().mockResolvedValue(42) };
      const svc = makeService({ skillRepo });
      expect(await svc.adminCountSkills()).toBe(42);
    });

    it("adminCountSkills throws ConfigurationError without skillRepo", async () => {
      const svc = makeService({});
      await expect(svc.adminCountSkills()).rejects.toBeInstanceOf(ConfigurationError);
    });

    it("adminFindAccessLogs forwards to accessLogRepo.findBySkill", async () => {
      const accessLogRepo = { findBySkill: vi.fn().mockResolvedValue([{ id: "log1" }]) };
      const svc = makeService({ accessLogRepo });
      await svc.adminFindAccessLogs("demo", 50);
      expect(accessLogRepo.findBySkill).toHaveBeenCalledWith("demo", 50);
    });

    it("adminFindAccessLogs throws ConfigurationError without accessLogRepo", async () => {
      const svc = makeService({});
      await expect(svc.adminFindAccessLogs("demo", 50)).rejects.toBeInstanceOf(ConfigurationError);
    });
  });

  describe("adminImportSkill", () => {
    it("delegates to importer.import", async () => {
      const importer = { import: vi.fn().mockResolvedValue({ slug: "imported" }) };
      const svc = makeService({ importer });
      await svc.adminImportSkill("/local/path", { tags: ["t"], versionBump: "patch" });
      expect(importer.import).toHaveBeenCalledWith("/local/path", { tags: ["t"], versionBump: "patch" });
    });

    it("throws ConfigurationError without importer", async () => {
      const svc = makeService({});
      await expect(svc.adminImportSkill("/p", {})).rejects.toBeInstanceOf(ConfigurationError);
    });
  });

  describe("adminTransitionLifecycle", () => {
    it("publishes skill:updated with post-transition meta", async () => {
      const updated = { ...SKILL_ROW, status: "published", visibility: "public", tags: ["a"] };
      const skillRepo = {
        findBySlug: vi.fn().mockResolvedValue(SKILL_ROW),
        update: vi.fn().mockResolvedValue(updated),
      };
      const skillProvider = {
        getSkillMeta: vi.fn().mockResolvedValue(SKILL_ROW),
        getSkillMetaById: vi.fn().mockResolvedValue(null),
      };
      const eventBus = { publish: vi.fn() };
      const svc = makeService({ skillRepo, skillProvider, eventBus });
      const out = await svc.adminTransitionLifecycle("demo", "published");
      expect(out.status).toBe("published");
      expect(eventBus.publish).toHaveBeenCalledWith({
        type: "skill:updated", slug: "demo", visibility: "public", tags: ["a"],
      });
    });
  });
});
