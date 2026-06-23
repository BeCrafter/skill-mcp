import { Command } from "commander";
import { getConfig } from "../config/index.js";
import { banner, c } from "./ui.js";
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
import { loginAction, logoutAction, whoamiAction, resetPasswordAction } from "./commands/auth-cmd.js";
import { initAction } from "./commands/init-cmd.js";

export async function createCli(): Promise<Command> {
  const config = getConfig();
  const program = new Command()
    .name("skill-mcp")
    .description("Cloud Skill File System & MCP Permission Gateway")
    .version(config.app.version, "-v, --version")
    .addHelpText("before", `\n${banner("skill-mcp", config.app.version, "Cloud Skill File System & MCP Permission Gateway")}\n`)
    .addHelpText("after", `\n  ${c.dim("Examples:")}\n\n    ${c.dim("$")}  skill-mcp serve --port 3001\n    ${c.dim("$")}  skill-mcp list\n    ${c.dim("$")}  skill-mcp info my-skill\n    ${c.dim("$")}  skill-mcp import ./my-skill\n`)
    .configureHelp({
      styleTitle:       (str: string) => c.bold(str),
      styleSubcommandText:  (str: string) => c.bold(str),
      styleOptionText:      (str: string) => c.cyan(str),
      styleDescriptionText: (str: string) => c.dim(str),
      styleCommandText:     (str: string) => c.bold(str),
      styleArgumentText:    (str: string) => c.yellow(str),
    })
    .configureOutput({
      outputError: (str: string, write: (str: string) => void) => {
        // Strip Commander's "error: " prefix and wrap with our formatting
        const msg = str.replace(/^error:\s*/i, "").replace(/\n$/, "").trim();
        if (msg) {
          write(`\n  ${c.boldRed("✗")}  ${msg}\n\n`);
        }
      },
    });

  program
    .command("serve")
    .description("Start MCP server (stdio, SSE, or HTTP transport)")
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
    .description("Import skill from local path, npm package, or Git repo")
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
    .description("List all skills with status and metadata")
    .option("--tags <tags>", "Filter by tags")
    .action(async (opts) => {
      await listAction(opts);
    });

  program
    .command("info <slug>")
    .description("Show detailed skill information (metadata, files, status)")
    .action(async (slug) => {
      await infoAction(slug);
    });

  program
    .command("search")
    .description("Search skills by name or keyword")
    .requiredOption("--name <name>", "Skill name to search")
    .action(async (opts) => {
      await searchAction(opts.name);
    });

  program
    .command("remove <slug>")
    .description("Remove a skill and its stored files")
    .option("--force", "Skip confirmation")
    .action(async (slug, opts) => {
      await removeAction(slug, opts);
    });

  program
    .command("update <slug>")
    .description("Update skill metadata (category, tags, description)")
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
    .description("Show version history for a skill")
    .option("--show <version>", "Show details for a specific version")
    .action(async (slug, opts) => {
      await versionsAction(slug, { show: opts.show as string | undefined });
    });

  program
    .command("rollback <slug>")
    .description("Roll back skill to a previous version")
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
    .description("Validate skill package structure and content")
    .action(async (path) => {
      await lintAction(path);
    });

  // =========================================================
  // Migration tools (P0-8 — SQLite → Postgres readiness)
  // =========================================================
  program
    .command("migrate:check")
    .description("Check database compatibility for SQLite → Postgres migration")
    .action(async (opts) => {
      await migrateCheckAction({ targetUrl: opts.target as string | undefined });
    });

  // =========================================================
  // Manifest schema migration (P1-21 — review §14.5)
  // =========================================================
  program
    .command("manifest:migrate <dir>")
    .description("Add manifest_schema field to skill packages missing it")
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
    .description("Manage skill pipelines (DAG-based orchestration)");

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
    .description("Run and manage skill evaluation cases")

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

  // ── System initialization ──────────────────────────────────────────
  program
    .command("init")
    .description("Initialize system with first superadmin user")
    .requiredOption("--username <username>", "Superadmin username")
    .requiredOption("--password <password>", "Superadmin password (min 8 chars)")
    .action(async (opts) => {
      await initAction({ username: opts.username, password: opts.password });
    });

  // ── Auth commands ─────────────────────────────────────────────────
  const authCmd = program
    .command("auth")
    .description("Authentication commands");

  authCmd
    .command("login")
    .description("Log in with username and password")
    .action(async () => { await loginAction(); });

  authCmd
    .command("logout")
    .description("Clear stored credentials")
    .action(async () => { await logoutAction(); });

  authCmd
    .command("whoami")
    .description("Show current authenticated user")
    .action(async () => { await whoamiAction(); });

  authCmd
    .command("reset-password")
    .description("Reset a user's password (requires local DB access)")
    .requiredOption("--username <username>", "Username")
    .requiredOption("--password <password>", "New password (min 8 chars)")
    .action(async (opts) => {
      await resetPasswordAction({ username: opts.username, password: opts.password });
    });

  // ── User management ────────────────────────────────────────────────
  const userCmd = program
    .command("user")
    .description("Manage users, tokens, and role assignments");

  userCmd
    .command("list")
    .description("List all users")
    .action(async () => { await userListAction(); });

  userCmd
    .command("create")
    .description("Create a new user")
    .option("--name <name>", "User name")
    .option("--username <username>", "Login username (for admin/superadmin)")
    .option("--password <password>", "Login password (for admin/superadmin, min 8 chars)")
    .option("--user-type <type>", "User type: user|admin", "user")
    .option("--role-ids <ids>", "Comma-separated role IDs to assign")
    .option("--ttl <duration>", "Token time-to-live (e.g. 30d, 12h, 45m, 3600s). Omit for non-expiring tokens.")
    .action(async (opts) => {
      await userCreateAction({
        name: opts.name as string | undefined,
        username: opts.username as string | undefined,
        password: opts.password as string | undefined,
        userType: opts.userType as string | undefined,
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

  // ── Role management ────────────────────────────────────────────────
  const roleCmd = program
    .command("role")
    .description("Manage roles and permission tags");

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
