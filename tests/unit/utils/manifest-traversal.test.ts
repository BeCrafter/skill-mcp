import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillFiles, validateSkillMeta } from "@/utils/manifest.js";
import { InvalidPathError } from "@/utils/errors.js";

describe("manifest path-traversal hardening (T-601)", () => {
  let root: string;
  let skillDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-traversal-"));
    skillDir = join(root, "pkg");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# entry");
    // Sibling secret file the attacker would try to exfiltrate.
    writeFileSync(join(root, "secret.txt"), "top secret");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it("rejects meta.files entries that escape the skill root", () => {
    expect(() =>
      readSkillFiles(skillDir, {
        name: "x",
        entry: "SKILL.md",
        files: ["../secret.txt"],
      } as any),
    ).toThrow(InvalidPathError);
  });

  it("rejects absolute meta.files entries", () => {
    expect(() =>
      readSkillFiles(skillDir, {
        name: "x",
        entry: "SKILL.md",
        files: ["/etc/passwd"],
      } as any),
    ).toThrow(InvalidPathError);
  });

  it("rejects meta.entry that escapes the skill root", () => {
    expect(() =>
      validateSkillMeta(
        { name: "x", entry: "../secret.txt" } as any,
        skillDir,
      ),
    ).toThrow(InvalidPathError);
  });

  it("walk skips symlinks instead of following them", () => {
    // symlink inside the package pointing OUT to the sibling.
    symlinkSync(join(root, "secret.txt"), join(skillDir, "leak"));
    const files = readSkillFiles(skillDir);
    expect(files.find((f) => f.path === "leak")).toBeUndefined();
    // SKILL.md still picked up.
    expect(files.find((f) => f.path === "SKILL.md")).toBeDefined();
  });

  it("walk rejects pathological depth", () => {
    let cursor = skillDir;
    // Create 18 levels (> MAX_WALK_DEPTH=16).
    for (let i = 0; i < 18; i++) {
      cursor = join(cursor, "d");
      mkdirSync(cursor);
    }
    writeFileSync(join(cursor, "deep.txt"), "x");
    expect(() => readSkillFiles(skillDir)).toThrow(/max depth/);
  });

  it("walk rejects too many files", () => {
    // 1001 files > MAX_FILES_PER_PACKAGE=1000.
    for (let i = 0; i < 1001; i++) {
      writeFileSync(join(skillDir, `f${i}.txt`), "x");
    }
    expect(() => readSkillFiles(skillDir)).toThrow(/max file count/);
  });
});
