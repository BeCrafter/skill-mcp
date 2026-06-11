import { Command } from "commander";
import { getConfig } from "../config/index.js";
import { serveAction } from "./commands/serve-cmd.js";
import { importAction } from "./commands/import-cmd.js";
import { listAction } from "./commands/list-cmd.js";
import { infoAction } from "./commands/info-cmd.js";
import { searchAction } from "./commands/search-cmd.js";
import { removeAction } from "./commands/remove-cmd.js";
import { updateAction } from "./commands/update-cmd.js";
import { versionsAction } from "./commands/versions-cmd.js";
import { rollbackAction } from "./commands/rollback-cmd.js";
import { lintAction } from "./commands/lint-cmd.js";
import { pipelineValidateAction, pipelineGraphAction, pipelineRunAction } from "./commands/pipeline-cmd.js";
import { userListAction, userCreateAction, userGetAction, userDeleteAction, userAssignRolesAction, userRotateTokenAction } from "./commands/user-cmd.js";
import { roleListAction, roleCreateAction, roleGetAction, roleUpdateAction, roleDeleteAction } from "./commands/role-cmd.js";
import { migrateCheckAction } from "./commands/migrate-cmd.js";
import { manifestMigrateAction } from "./commands/manifest-migrate-cmd.js";
import { evalListAction, evalRunAction, evalResultsAction } from "./commands/eval-cmd.js";

export async function createCli(): Promise<Command> {
  const config = getConfig();

  const program = new Command()
    .name("skill-mcp")
    .description("Cloud Skill File System & MCP Permission Gateway")
    .version(config.app.version);

  program
    .command("serve")
    .description("Start MCP Server")
    .option("--transport <type>", "Transport type: stdio|sse|http", config.transport.type)
    .option("--port <number>", "HTTP port (for sse/http)", String(config.transport.port))
    .option("--host <host>", "HTTP host", config.transport.host)
    .option("--mode <mode>", "Deployment mode: standalone|gateway|cloud", config.deployment.mode)
    .option("--auth-token <token>", "Stdio mode: bearer token used for permission isolation (overrides SKILL_MCP_AUTH_TOKEN)")
    .action(async (opts) => {
      await serveAction({
        transport: opts.transport as "stdio" | "sse" | "http",
        port: parseInt(opts.port, 10),
        host: opts.host,
        mode: opts.mode as "standalone" | "gateway" | "cloud",
        authToken: opts.authToken as string | undefined,
      });
    });

  program
    .command("import <source>")
    .description("Import a skill package from local path or Git repo")
    .option("--category <category>", "Server-side category")
    .option("--tags <tags>", "Server-side tags (comma-separated)")
    .option("--description <desc>", "Server-side description for index")
    .option("--id <id>", "Target skill ID for overwrite update")
    .option("--version-bump <type>", "Version bump: major|minor|patch", "patch")
    .option("--overwrite", "Overwrite if skill exists with same name")
    .option("--allow-duplicate", "Allow importing as a new entry even if a skill with the same name exists")
    .option("--slug <slug>", "Custom slug for the imported skill (used with --allow-duplicate or new skills)")
    .option("--branch <branch>", "Git branch (for git sources)")
    .option("--sub-dir <path>", "Sub-directory within git repo")
    .action(async (source, opts) => {
      await importAction(source, {
        category: opts.category as string | undefined,
        tags: opts.tags ? (opts.tags as string).split(",").map((t: string) => t.trim()) : undefined,
        description: opts.description as string | undefined,
        targetId: opts.id as string | undefined,
        versionBump: opts.versionBump as "major" | "minor" | "patch",
        overwrite: opts.overwrite as boolean | undefined,
        allowDuplicate: opts.allowDuplicate as boolean | undefined,
        slug: opts.slug as string | undefined,
        branch: opts.branch as string | undefined,
        subDir: opts.subDir as string | undefined,
      });
    });

  program
    .command("list")
    .description("List all skills")
    .option("--name <name>", "Filter by skill name")
    .option("--tags <tags>", "Filter by tags")
    .action(async (opts) => {
      await listAction(opts);
    });

  program
    .command("info <slug>")
    .description("Show skill details by slug")
    .action(async (slug) => {
      await infoAction(slug);
    });

  program
    .command("search")
    .description("Search skills by name")
    .requiredOption("--name <name>", "Skill name to search")
    .action(async (opts) => {
      await searchAction(opts.name);
    });

  program
    .command("remove <slug>")
    .description("Remove a skill")
    .option("--force", "Skip confirmation")
    .action(async (slug, opts) => {
      await removeAction(slug, opts);
    });

  program
    .command("update <slug>")
    .description("Update skill server-side metadata")
    .option("--category <category>", "Update category")
    .option("--tags <tags>", "Update tags (comma-separated)")
    .option("--description <desc>", "Update description")
    .option("--display-name <name>", "Update display name")
    .action(async (slug, opts) => {
      await updateAction(slug, {
        category: opts.category as string | undefined,
        tags: opts.tags ? (opts.tags as string).split(",").map((t: string) => t.trim()) : undefined,
        description: opts.description as string | undefined,
        displayName: opts.displayName as string | undefined,
      });
    });

  program
    .command("versions <slug>")
    .description("Show skill version history")
    .option("--show <version>", "Show details for a specific version")
    .action(async (slug, opts) => {
      await versionsAction(slug, { show: opts.show as string | undefined });
    });

  program
    .command("rollback <slug>")
    .description("Rollback skill to a previous version")
    .requiredOption("--to <version>", "Target version to rollback to")
    .option("--bump <type>", "Version bump type: major|minor|patch", "patch")
    .action(async (slug, opts) => {
      await rollbackAction(slug, {
        to: opts.to as string,
        bump: (opts.bump as "major" | "minor" | "patch") ?? "patch",
      });
    });

  program
    .command("lint <path>")
    .description("Lint a skill package directory")
    .action(async (path) => {
      await lintAction(path);
    });

  // =========================================================
  // Migration tools (P0-8 — SQLite → Postgres readiness)
  // =========================================================
  program
    .command("migrate:check")
    .description("Scan source/target DATABASE_URL for dialect-migration risks (read-only, P0-8)")
    .option("--target <url>", "Target dialect URL (e.g. postgres://...). Defaults to DATABASE_URL or current source")
    .action(async (opts) => {
      await migrateCheckAction({ targetUrl: opts.target as string | undefined });
    });

  // =========================================================
  // Manifest schema migration (P1-21 — review §14.5)
  // =========================================================
  program
    .command("manifest:migrate <dir>")
    .description("Scan skill packages for missing manifest_schema and migrate (review §14.5)")
    .option("--apply", "Rewrite SKILL.md files in place (default: dry-run)")
    .option("--patch", "Emit a unified diff to stdout instead (suitable for `git apply`)")
    .action(async (dir, opts) => {
      await manifestMigrateAction(dir, {
        apply: opts.apply as boolean | undefined,
        patch: opts.patch as boolean | undefined,
      });
    });

  // =========================================================
  // Pipeline management commands
  // =========================================================
  const pipelineCmd = program
    .command("pipeline")
    .description("Manage skill pipelines (DAG orchestration)");

  pipelineCmd
    .command("validate <yaml-path>")
    .description("Validate pipeline YAML definition")
    .action(async (yamlPath) => {
      await pipelineValidateAction(yamlPath);
    });

  pipelineCmd
    .command("graph <yaml-path>")
    .description("Visualize pipeline DAG as ASCII")
    .action(async (yamlPath) => {
      await pipelineGraphAction(yamlPath);
    });

  pipelineCmd
    .command("run <yaml-path>")
    .description("Execute pipeline (dry-run by default)")
    .option("--input <key=value...>", "Pipeline inputs (repeatable)", (value, prev: string[]) => {
      return prev ? [...prev, value] : [value];
    }, [] as string[])
    .option("--dry-run", "Dry-run mode (default: true)", true)
    .action(async (yamlPath, opts) => {
      await pipelineRunAction(yamlPath, {
        input: opts.input as string[] | undefined,
        dryRun: opts.dryRun as boolean,
      });
    });

  // =========================================================
  // P1-12 stage 2 — Eval framework (case persistence + runner)
  // =========================================================
  const evalCmd = program
    .command("eval")
    .description("Run skill eval cases (P1-12 stage 2)");

  evalCmd
    .command("list <slug>")
    .description("List persisted eval cases for a skill")
    .action(async (slug) => { await evalListAction(slug); });

  evalCmd
    .command("run <slug>")
    .description("Run every eval case for a skill against the stub provider, persist results")
    .action(async (slug) => { await evalRunAction(slug); });

  evalCmd
    .command("results <slug>")
    .description("Show recent eval runs for a skill")
    .option("--limit <n>", "Max rows to display (default 20)", "20")
    .action(async (slug, opts) => {
      await evalResultsAction(slug, { limit: parseInt(opts.limit as string, 10) });
    });

  // =========================================================
  // User management commands
  // =========================================================
  const userCmd = program
    .command("user")
    .description("Manage users");

  userCmd
    .command("list")
    .description("List all users")
    .action(async () => { await userListAction(); });

  userCmd
    .command("create")
    .description("Create a new user")
    .option("--name <name>", "User name")
    .option("--role-ids <ids>", "Comma-separated role IDs to assign")
    .option("--ttl <duration>", "Token time-to-live (e.g. 30d, 12h, 45m, 3600s). Omit for non-expiring tokens.")
    .action(async (opts) => {
      await userCreateAction({
        name: opts.name as string | undefined,
        roleIds: opts.roleIds ? (opts.roleIds as string).split(",").map((s: string) => s.trim()) : undefined,
        ttl: opts.ttl as string | undefined,
      });
    });

  userCmd
    .command("rotate-token <userId>")
    .description("Rotate a user's token. Old token remains valid for the grace window (default 7d).")
    .option("--ttl <duration>", "New token time-to-live (e.g. 30d). Omit for non-expiring.")
    .option("--grace <duration>", "Old token grace window (default 7d).")
    .action(async (userId, opts) => {
      await userRotateTokenAction(userId, {
        ttl: opts.ttl as string | undefined,
        grace: opts.grace as string | undefined,
      });
    });

  userCmd
    .command("get <userId>")
    .description("Get user details")
    .action(async (userId) => { await userGetAction(userId); });

  userCmd
    .command("delete <userId>")
    .description("Delete a user")
    .action(async (userId) => { await userDeleteAction(userId); });

  userCmd
    .command("assign-roles <userId>")
    .description("Assign roles to a user (replaces existing)")
    .requiredOption("--role-ids <ids>", "Comma-separated role IDs")
    .action(async (userId, opts) => {
      const roleIds = (opts.roleIds as string).split(",").map((s: string) => s.trim());
      await userAssignRolesAction(userId, roleIds);
    });

  // =========================================================
  // Role management commands
  // =========================================================
  const roleCmd = program
    .command("role")
    .description("Manage roles");

  roleCmd
    .command("list")
    .description("List all roles")
    .action(async () => { await roleListAction(); });

  roleCmd
    .command("create")
    .description("Create a new role")
    .requiredOption("--name <name>", "Role name")
    .requiredOption("--tags <tags>", "Comma-separated tags")
    .option("--description <desc>", "Role description")
    .action(async (opts) => {
      await roleCreateAction({
        name: opts.name as string,
        description: opts.description as string | undefined,
        tags: (opts.tags as string).split(",").map((t: string) => t.trim()),
      });
    });

  roleCmd
    .command("get <roleId>")
    .description("Get role details")
    .action(async (roleId) => { await roleGetAction(roleId); });

  roleCmd
    .command("update <roleId>")
    .description("Update a role")
    .option("--name <name>", "New name")
    .option("--tags <tags>", "New tags (comma-separated)")
    .option("--description <desc>", "New description")
    .action(async (roleId, opts) => {
      await roleUpdateAction(roleId, {
        name: opts.name as string | undefined,
        description: opts.description as string | undefined,
        tags: opts.tags ? (opts.tags as string).split(",").map((t: string) => t.trim()) : undefined,
      });
    });

  roleCmd
    .command("delete <roleId>")
    .description("Delete a role")
    .action(async (roleId) => { await roleDeleteAction(roleId); });

  return program;
}
