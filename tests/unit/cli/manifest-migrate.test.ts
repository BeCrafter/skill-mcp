/**
 * P1-21 — `skill-mcp manifest:migrate` end-to-end coverage on a real
 * temporary directory tree. We avoid mocking fs so the YAML
 * line-injection logic gets exercised against actual files.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  injectManifestSchema,
  scanPackages,
  manifestMigrateAction,
} from "../../../src/cli/commands/manifest-migrate-cmd.js";

let root: string;

function writeSkill(dir: string, frontmatter: string, body = "# Body\n"): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\n${frontmatter}\n---\n${body}`, "utf-8");
  return file;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "manifest-migrate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("injectManifestSchema()", () => {
  it("inserts manifest_schema as first frontmatter key", () => {
    const before = `---\nname: foo\nversion: 1.0.0\n---\n# Body\n`;
    const after = injectManifestSchema(before);
    expect(after).toBe(`---\nmanifest_schema: "1.0"\nname: foo\nversion: 1.0.0\n---\n# Body\n`);
  });

  it("preserves CRLF line endings", () => {
    const before = `---\r\nname: foo\r\n---\r\nbody`;
    const after = injectManifestSchema(before);
    expect(after).toBe(`---\r\nmanifest_schema: "1.0"\r\nname: foo\r\n---\r\nbody`);
  });

  it("returns null when manifest_schema is already present", () => {
    const before = `---\nmanifest_schema: "1.0"\nname: foo\n---\nbody`;
    expect(injectManifestSchema(before)).toBeNull();
  });

  it("returns null when no frontmatter block exists", () => {
    expect(injectManifestSchema("# just markdown")).toBeNull();
  });
});

describe("scanPackages()", () => {
  it("classifies missing/ok/invalid/unsupported-major correctly", () => {
    writeSkill(join(root, "legacy"), "name: legacy");
    writeSkill(join(root, "ok"), `manifest_schema: "1.0"\nname: ok`);
    writeSkill(join(root, "future"), `manifest_schema: "2.0"\nname: future`);
    writeSkill(join(root, "broken"), `manifest_schema: "abc"\nname: broken`);

    const scans = scanPackages(root);
    const byName: Record<string, string> = {};
    for (const s of scans) byName[s.relPath] = s.status;
    expect(byName[join("legacy", "SKILL.md")]).toBe("missing");
    expect(byName[join("ok", "SKILL.md")]).toBe("ok");
    expect(byName[join("future", "SKILL.md")]).toBe("unsupported-major");
    expect(byName[join("broken", "SKILL.md")]).toBe("invalid");
  });

  it("ignores .git, node_modules, .versions, __staging__", () => {
    writeSkill(join(root, ".git", "weird"), "name: weird");
    writeSkill(join(root, "node_modules", "x"), "name: x");
    writeSkill(join(root, ".versions", "v1"), "name: v1");
    writeSkill(join(root, "__staging__", "abc"), "name: abc");
    writeSkill(join(root, "real"), "name: real");

    const scans = scanPackages(root);
    expect(scans).toHaveLength(1);
    expect(scans[0].relPath).toBe(join("real", "SKILL.md"));
  });

  it("reports unparseable when frontmatter delimiter is broken", () => {
    const dir = join(root, "broken-fm");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter here\njust text\n");
    const scans = scanPackages(root);
    expect(scans).toHaveLength(1);
    expect(scans[0].status).toBe("unparseable");
  });
});

describe("manifestMigrateAction() — apply mode", () => {
  it("dry-run does not modify files (default)", async () => {
    const file = writeSkill(join(root, "a"), "name: a");
    const before = readFileSync(file, "utf-8");
    // suppress stdout
    const origLog = console.log;
    console.log = () => {};
    try {
      await manifestMigrateAction(root, {});
    } finally {
      console.log = origLog;
    }
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("--apply rewrites missing files in place", async () => {
    const fileA = writeSkill(join(root, "a"), "name: a");
    const fileB = writeSkill(join(root, "b"), "name: b");
    const origLog = console.log;
    console.log = () => {};
    try {
      await manifestMigrateAction(root, { apply: true });
    } finally {
      console.log = origLog;
    }
    expect(readFileSync(fileA, "utf-8")).toContain('manifest_schema: "1.0"');
    expect(readFileSync(fileB, "utf-8")).toContain('manifest_schema: "1.0"');
  });

  it("--apply leaves already-migrated files untouched", async () => {
    const file = writeSkill(join(root, "ok"), `manifest_schema: "1.0"\nname: ok`);
    const before = readFileSync(file, "utf-8");
    const origLog = console.log;
    console.log = () => {};
    try {
      await manifestMigrateAction(root, { apply: true });
    } finally {
      console.log = origLog;
    }
    expect(readFileSync(file, "utf-8")).toBe(before);
  });
});
