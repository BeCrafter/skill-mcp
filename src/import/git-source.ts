import { simpleGit } from "simple-git";
import { rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { SkillFileInput } from "../types/index.js";
import { parseSkillMeta, validateSkillMeta, readSkillFiles } from "../utils/manifest.js";
import { getLogger } from "../utils/logger.js";
import { BadRequestError } from "../utils/errors.js";

const logger = getLogger();

// T-603 — simple-git invokes git via spawn (no shell), so there is no shell
// injection. But it does NOT auto-prepend `--` between flags and positional
// args. A repoUrl like `--upload-pack=cmd` would be interpreted by git as a
// flag and can lead to local code execution (CVE-2017-1000117 family). We
// defend in depth: validate URL/branch shapes, then call `git.raw([...])`
// with an explicit `--` separator before positional arguments.
const GIT_URL_RE = /^(?:https?:\/\/|git:\/\/|ssh:\/\/|git@[\w.-]+:)[^\s]{1,2048}$/;
const GIT_BRANCH_RE = /^[A-Za-z0-9._/-]{1,255}$/;

function validateRepoUrl(url: string): void {
  if (!GIT_URL_RE.test(url) || url.startsWith("-")) {
    throw new BadRequestError(`Invalid git repo URL: ${url}`);
  }
}

function validateBranch(branch: string): void {
  if (!GIT_BRANCH_RE.test(branch) || branch.startsWith("-")) {
    throw new BadRequestError(`Invalid git branch: ${branch}`);
  }
}

export class GitSourceResolver {
  async resolve(
    repoUrl: string,
    options?: { branch?: string; subDir?: string },
  ): Promise<SkillFileInput[]> {
    validateRepoUrl(repoUrl);
    if (options?.branch) validateBranch(options.branch);

    const tmpDir = join(tmpdir(), `skill-import-${randomUUID()}`);

    try {
      const git = simpleGit();
      // raw() lets us put the `--` separator before positional args so
      // even a maliciously-shaped (but somehow validation-bypassing) URL
      // can't be re-interpreted as a flag.
      const args: string[] = ["clone", "--depth", "1"];
      if (options?.branch) {
        args.push("--branch", options.branch);
      }
      args.push("--", repoUrl, tmpDir);
      await git.raw(args);

      let skillDir = tmpDir;
      if (options?.subDir) {
        // T-719 — subDir flows from `POST /api/admin/skills/import-git` body
        // (admin-authenticated, but defense-in-depth). Without normalization,
        // a value like `../../../etc` resolves outside the per-clone tmpDir
        // and lets the importer ingest arbitrary local files (anywhere a
        // SKILL.md happens to exist) as a skill package. Pin to the cloned
        // tree.
        const tmpRoot = resolve(tmpDir);
        const candidate = resolve(tmpRoot, options.subDir);
        if (candidate !== tmpRoot && !candidate.startsWith(tmpRoot + sep)) {
          throw new BadRequestError(`subDir escapes repository root: ${options.subDir}`);
        }
        skillDir = candidate;
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
      await rm(tmpDir, { recursive: true, force: true }).catch((err) =>
        logger.warn({ err, tmpDir }, "git-source tmpdir cleanup failed"),
      );
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
