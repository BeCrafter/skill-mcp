import { simpleGit } from "simple-git";
import { rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SkillFileInput } from "../types/index.js";
import { parseSkillMeta, validateSkillMeta, readSkillFiles } from "../utils/manifest.js";

export class GitSourceResolver {
  async resolve(
    repoUrl: string,
    options?: { branch?: string; subDir?: string },
  ): Promise<SkillFileInput[]> {
    const tmpDir = join(tmpdir(), `skill-import-${Date.now()}`);

    try {
      const git = simpleGit();
      const cloneArgs: string[] = ["--depth", "1"];
      if (options?.branch) {
        cloneArgs.push("--branch", options.branch);
      }
      await git.clone(repoUrl, tmpDir, cloneArgs);

      let skillDir = tmpDir;
      if (options?.subDir) {
        skillDir = join(tmpDir, options.subDir);
      } else {
        skillDir = await this.findSkillRoot(tmpDir);
      }

      if (!existsSync(skillDir)) {
        throw new Error(`Skill directory not found: ${options?.subDir ?? "root"}`);
      }

      const meta = parseSkillMeta(skillDir);
      validateSkillMeta(meta, skillDir);
      return readSkillFiles(skillDir, meta);
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async findSkillRoot(dir: string): Promise<string> {
    if (existsSync(join(dir, "SKILL.md"))) {
      return dir;
    }

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const sub = join(dir, entry.name);
        if (existsSync(join(sub, "SKILL.md"))) {
          return sub;
        }
      }
    }

    return dir;
  }
}
