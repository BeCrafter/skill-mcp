import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillImporter } from "../../../src/import/importer.js";
import type { IStorageProvider } from "../../../src/storage/provider.interface.js";
import type { ICacheProvider } from "../../../src/cache/provider.interface.js";
import type { SkillRepository } from "../../../src/db/repositories/skill.repository.js";
import type { SkillFileRepository } from "../../../src/db/repositories/skill-file.repository.js";
import type { SkillEvalRepository } from "../../../src/db/repositories/skill-eval.repository.js";
import type { Logger } from "pino";
import type { SkillMeta } from "../../../src/types/index.js";

/**
 * P1-12 stage 2 — wiring contract pin: when the importer is constructed
 * with a SkillEvalRepository, importing a SKILL.md whose frontmatter
 * carries `eval_cases:` ends with `replaceAllForSkill(skillId, parsed)`
 * being invoked exactly once with the parsed cases. Without an evalRepo
 * the importer must continue to no-op cleanly (legacy callers).
 */

function makeStorage(): IStorageProvider {
  return {
    get: vi.fn().mockResolvedValue(Buffer.from("data")),
    exists: vi.fn().mockResolvedValue(false),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteDir: vi.fn().mockResolvedValue(undefined),
    moveDir: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    listRecursive: vi.fn().mockResolvedValue([]),
    isDirectory: vi.fn().mockResolvedValue(true),
    size: vi.fn().mockResolvedValue(0),
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
  } as unknown as Logger;
}

function makeCache(): ICacheProvider {
  return {
    get: vi.fn().mockResolvedValue(null),
    getWithMeta: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    delete: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    clearByPrefix: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSkillRepo(): SkillRepository {
  return {
    findByName: vi.fn().mockResolvedValue([]),
    findBySlug: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    findByNameAndHash: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: "sk-1", slug: "demo" } as SkillMeta),
    update: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
  } as unknown as SkillRepository;
}

function makeFileRepo(): SkillFileRepository {
  return {
    deleteBySkillId: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    replaceAll: vi.fn().mockResolvedValue(undefined),
    findBySkillId: vi.fn().mockResolvedValue([]),
  } as unknown as SkillFileRepository;
}

function makeEvalRepo(): SkillEvalRepository {
  return {
    replaceAllForSkill: vi.fn(),
    findCasesBySkillId: vi.fn().mockReturnValue([]),
    findCaseByName: vi.fn().mockReturnValue(null),
    countCasesBySkillId: vi.fn().mockReturnValue(0),
    appendRun: vi.fn(),
    findRunsBySkillVersion: vi.fn().mockReturnValue([]),
    findRecentRuns: vi.fn().mockReturnValue([]),
    findLatestRunStatusByCase: vi.fn().mockReturnValue(new Map()),
  } as unknown as SkillEvalRepository;
}

let tmpDir: string;

function writeSkillMd(content: string): void {
  writeFileSync(join(tmpDir, "SKILL.md"), content);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "importer-eval-cases-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SkillImporter wires eval_cases into SkillEvalRepository", () => {
  it("invokes replaceAllForSkill with parsed cases on import", async () => {
    writeSkillMd([
      "---",
      "name: demo",
      "version: 1.0.0",
      "description: with eval cases",
      "eval_cases:",
      "  - name: basic",
      "    input: hello",
      "    expected_output_contains: [hello]",
      "---",
      "",
      "# Demo",
      "Body.",
    ].join("\n"));

    const evalRepo = makeEvalRepo();
    const importer = new SkillImporter(
      makeStorage(), makeSkillRepo(), makeFileRepo(), makeCache(), makeLogger(),
      undefined, undefined, undefined, evalRepo,
    );

    await importer.import(tmpDir, {});

    expect(evalRepo.replaceAllForSkill).toHaveBeenCalledTimes(1);
    const [skillId, cases] = (evalRepo.replaceAllForSkill as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(skillId).toBe("sk-1");
    expect(cases).toHaveLength(1);
    expect(cases[0].name).toBe("basic");
    expect(cases[0].input).toBe("hello");
    expect(cases[0].expectedOutputContains).toEqual(["hello"]);
  });

  it("invokes replaceAllForSkill with [] when frontmatter has no eval_cases (prunes)", async () => {
    writeSkillMd([
      "---",
      "name: demo",
      "version: 1.0.0",
      "description: no eval cases",
      "---",
      "",
      "# Demo",
      "Body.",
    ].join("\n"));

    const evalRepo = makeEvalRepo();
    const importer = new SkillImporter(
      makeStorage(), makeSkillRepo(), makeFileRepo(), makeCache(), makeLogger(),
      undefined, undefined, undefined, evalRepo,
    );

    await importer.import(tmpDir, {});

    expect(evalRepo.replaceAllForSkill).toHaveBeenCalledTimes(1);
    const [, cases] = (evalRepo.replaceAllForSkill as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cases).toEqual([]);
  });

  it("does not require evalRepo (legacy call sites still work)", async () => {
    writeSkillMd([
      "---",
      "name: demo",
      "version: 1.0.0",
      "description: legacy",
      "---",
      "",
      "# Demo",
      "Body.",
    ].join("\n"));

    const importer = new SkillImporter(
      makeStorage(), makeSkillRepo(), makeFileRepo(), makeCache(), makeLogger(),
    );

    const result = await importer.import(tmpDir, {});
    expect(result.action).toBe("created");
  });
});
