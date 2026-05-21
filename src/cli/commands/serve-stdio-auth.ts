import type { Logger } from "pino";
import type { UserRepository } from "../../db/repositories/user.repository.js";
import type { SkillRepository } from "../../db/repositories/skill.repository.js";

export interface StdioAuthGuardDeps {
  userRepo: UserRepository;
  skillRepo: SkillRepository;
  logger: Logger;
  exit?: (code: number) => never;
}

/**
 * Stdio mode permission guard. When no token is configured but the DB already
 * has active users or non-public skills (private/internal), refuse to start
 * to avoid silent anonymous access. Empty / fully-public DBs continue to
 * start in legacy anonymous mode.
 */
export async function assertStdioTokenOrExit(
  stdioToken: string | undefined,
  deps: StdioAuthGuardDeps,
): Promise<void> {
  if (stdioToken) return;

  const { userRepo, skillRepo, logger } = deps;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const users = await userRepo.findAll();
  const hasActiveUser = users.some(u => u.status === "active");

  let hasNonPublicSkill = false;
  if (!hasActiveUser) {
    const allSkills = await skillRepo.findAll();
    hasNonPublicSkill = allSkills.some(s => s.visibility !== "public");
  }

  if (hasActiveUser || hasNonPublicSkill) {
    logger.error(
      { hasActiveUser, hasNonPublicSkill },
      "stdio mode requires a bearer token because the database contains users or non-public skills. " +
      "Set SKILL_MCP_AUTH_TOKEN env var or pass --auth-token <token>.",
    );
    exit(1);
    return;
  }

  logger.warn(
    "stdio mode is running anonymously. Non-public skills will be hidden once configured. " +
    "Set SKILL_MCP_AUTH_TOKEN to enable per-user permission isolation.",
  );
}
