import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalSourceResolver } from "../../../src/import/local-source.js";

function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: ${JSON.stringify(v)}`;
    return `${k}: ${v}`;
  });
  return `---\n${lines.join("\n")}\n---\n# body\n`;
}

describe("LocalSourceResolver", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "local-source-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("resolves a valid skill directory into file inputs", () => {
    writeFileSync(join(dir, "SKILL.md"), frontmatter({ name: "demo" }));
    const files = new LocalSourceResolver().resolve(dir);
    const paths = files.map(f => f.path);
    expect(paths).toContain("SKILL.md");
  });

  it("includes nested files declared in the frontmatter `files` list", () => {
    writeFileSync(join(dir, "SKILL.md"), frontmatter({ name: "demo", files: ["sub/extra.md"] }));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "extra.md"), "extra");
    const files = new LocalSourceResolver().resolve(dir);
    const paths = files.map(f => f.path);
    expect(paths).toContain("sub/extra.md");
  });

  it("throws 'Directory not found' for a missing path", () => {
    expect(() => new LocalSourceResolver().resolve(join(dir, "nope")))
      .toThrow(/Directory not found/);
  });

  it("parseSkillMeta() also throws when the directory is missing", () => {
    expect(() => new LocalSourceResolver().parseSkillMeta(join(dir, "missing")))
      .toThrow(/Directory not found/);
  });

  it("parseSkillMeta returns the parsed frontmatter object", () => {
    writeFileSync(join(dir, "SKILL.md"), frontmatter({ name: "demo", version: "1.2.3" }));
    const meta = new LocalSourceResolver().parseSkillMeta(dir);
    expect(meta.name).toBe("demo");
    expect(meta.version).toBe("1.2.3");
  });

  it("rejects a SKILL.md without a name field", () => {
    writeFileSync(join(dir, "SKILL.md"), `---\nversion: 1\n---\n# body\n`);
    expect(() => new LocalSourceResolver().resolve(dir)).toThrow(/name is required/);
  });

  it("rejects when SKILL.md is missing entirely", () => {
    expect(() => new LocalSourceResolver().resolve(dir)).toThrow(/SKILL\.md not found/);
  });
});
