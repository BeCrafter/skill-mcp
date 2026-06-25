import { Command, Help } from "commander";
import { getConfig } from "../config/index.js";
import { banner, c, sep } from "./ui.js";
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

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g;
function visLen(s: string): number { return s.replace(ANSI_RE, "").length; }
function padTo(s: string, width: number): string { return s + " ".repeat(Math.max(0, width - visLen(s))); }

/** Colorize a usage string: command=cyan, [options]=dim, <arg>=yellow. */
function styleUsage(raw: string): string {
  return raw
    .replace(/\[options\]/g, c.dim("[options]"))
    .replace(/<[^>]+>/g, m => c.yellow(m));
}

/** Format a single command row with aligned description. */
function cmdRow(name: string, desc: string, indent: number, colWidth: number): string {
  const styled = styleUsage(name);
  return " ".repeat(indent) + padTo(styled, colWidth) + c.dim(desc);
}

/** Format an option row with aligned description. */
function optRow(flags: string, desc: string, indent: number): string {
  return " ".repeat(indent) + padTo(c.cyan(flags), 28) + c.dim(desc);
}

export async function createCli(): Promise<Command> {
  const config = getConfig();
  const program = new Command()
    .name("skill-mcp")
    .description("Cloud Skill File System & MCP Permission Gateway")
    .version(config.app.version, "-v, --version")
    .option("--server-url <url>", "Remote server URL (overrides SKILL_MCP_SERVER_URL env)")
    .addHelpText("before", `\n${banner("skill-mcp", config.app.version, "Cloud Skill File System & MCP Permission Gateway")}\n`)
    .configureHelp({
      formatHelp(cmd: Command, helper: Help): string {
        const isRoot = !cmd.parent;
        const subs = helper.visibleCommands(cmd).filter(s => s.name() !== "help");
        const opts = helper.visibleOptions(cmd).filter(o => o.flags !== "-h, --help");
        const lines: string[] = [];

        if (isRoot) {
          // ── Root: grouped category layout ──
          const CATEGORIES: Array<{ label: string; icon: string; names: string[] }> = [
            { label: "Skills",    icon: "◆", names: ["serve", "import", "list", "info", "search", "remove", "update", "versions", "rollback"] },
            { label: "Quality",   icon: "◆", names: ["lint", "eval"] },
            { label: "Pipeline",  icon: "◆", names: ["pipeline"] },
            { label: "System",    icon: "◆", names: ["init", "migrate:check", "manifest:migrate"] },
            { label: "Admin",     icon: "◆", names: ["auth", "user", "role"] },
          ];

          const allCmds = subs;
          const used = new Set<string>();

          // Options
          if (opts.length > 0) {
            lines.push(`  ${c.bold("OPTIONS")}`);
            for (const o of opts) lines.push(optRow(o.flags, o.description ?? "", 4));
            lines.push("");
          }

          // Categories
          for (const cat of CATEGORIES) {
            const cmds = allCmds.filter(s => cat.names.includes(s.name()));
            if (cmds.length === 0) continue;
            lines.push(`  ${c.bold(cat.label.toUpperCase())}`);
            for (const sub of cmds) {
              used.add(sub.name());
              const subCmds = helper.visibleCommands(sub).filter(s => s.name() !== "help");
              if (subCmds.length > 0) {
                // parent group — bold green to stand out from leaf commands
                const styled = styleUsage(sub.name());
                lines.push(`    ${c.boldGreen(styled)}${" ".repeat(Math.max(1, 18 - sub.name().length))}${c.dim(sub.description())}`);
                for (const child of subCmds) {
                  const usage = child.name() + (child.usage() ? " " + child.usage() : "");
                  lines.push(cmdRow("  " + usage, child.description() ?? "", 6, 36));
                }
              } else {
                const usage = sub.name() + (sub.usage() ? " " + sub.usage() : "");
                lines.push(cmdRow("  " + usage, sub.description() ?? "", 4, 34));
              }
            }
            lines.push("");
          }

          // Uncategorized
          const rest = allCmds.filter(s => !used.has(s.name()));
          if (rest.length > 0) {
            lines.push(`  ${c.bold("OTHER")}`);
            for (const sub of rest) {
              const usage = sub.name() + (sub.usage() ? " " + sub.usage() : "");
              lines.push(cmdRow("  " + usage, sub.description() ?? "", 4, 34));
            }
            lines.push("");
          }

          // Examples
          lines.push(`  ${c.bold("EXAMPLES")}`);
          const exs = [
            ["skill-mcp serve",                "Start the MCP server"],
            ["skill-mcp list",                 "List all skills"],
            ["skill-mcp info my-skill",        "Show skill details"],
            ["skill-mcp import ./my-skill",    "Import a skill package"],
            ["skill-mcp user create --name u", "Create a user"],
          ];
          for (const [cmd, desc] of exs) {
            lines.push(`    ${c.dim("$")}  ${c.cyan(cmd)}${" ".repeat(Math.max(1, 32 - cmd.length))}${c.dim(desc)}`);
          }
          lines.push("");

        } else if (subs.length > 0) {
          // ── Mid-level: parent with subcommands (user, role, auth, eval, pipeline) ──
          lines.push("");
          lines.push(`  ${c.bold(cmd.name().toUpperCase())}  ${c.dim(cmd.description())}`);
          lines.push(`  ${sep(60)}`);
          lines.push("");

          // Show usage hint
          const childNames = subs.map(s => s.name()).join("|");
          lines.push(`  ${c.dim("Usage:")}  ${c.cyan(cmd.name())} ${c.yellow("<" + childNames + ">")} ${c.dim("[options]")}`);
          lines.push("");

          // Subcommands
          lines.push(`  ${c.bold("COMMANDS")}`);
          for (const s of subs) {
            const usage = s.name() + (s.usage() ? " " + s.usage() : "");
            lines.push(cmdRow("  " + usage, s.description() ?? "", 4, 36));
          }
          lines.push("");

          // Global options
          lines.push(`  ${c.bold("OPTIONS")}`);
          lines.push(optRow("-h, --help", "display help for command", 4));
          lines.push(optRow("--server-url <url>", "Remote server URL", 4));
          lines.push("");

        } else {
          // ── Leaf: terminal command with options ──
          const parentName = cmd.parent?.name() ?? "";
          lines.push("");
          lines.push(`  ${c.bold(cmd.name().toUpperCase())}  ${c.dim(cmd.description())}`);
          lines.push(`  ${sep(60)}`);
          lines.push("");

          // Usage
          const args = cmd.usage() || "";
          lines.push(`  ${c.dim("Usage:")}  ${c.cyan(parentName + " " + cmd.name())} ${styleUsage(args)}`.trimEnd());
          lines.push("");

          // Options
          if (opts.length > 0) {
            lines.push(`  ${c.bold("OPTIONS")}`);
            for (const o of opts) lines.push(optRow(o.flags, o.description ?? "", 4));
            lines.push("");
          }
        }

        return lines.join("\n");
      },
    })
    .configureOutput({
      getOutHasColors: () => !!process.stdout.isTTY,
      getErrHasColors: () => !!process.stderr.isTTY,
      outputError: (str: string, write: (str: string) => void) => {
        const msg = str.replace(/^error:\s*/i, "").replace(/\n$/, "").trim();
        if (msg) {
          write(`\n  ${c.boldRed("✗")}  ${msg}\n\n`);
        }
      },
    });

  // Pass global --server-url to all subcommands via preAction hook
  program.hook("preAction", (thisCommand, actionCommand) => {
    const globalOpts = thisCommand.opts();
    if (globalOpts.serverUrl) {
      actionCommand.setOptionValue("serverUrl", globalOpts.serverUrl);
    }
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
        serverUrl: opts.serverUrl as string | undefined,
      });
    });

  program
    .command("list")
    .description("List all skills with status and metadata")
    .option("--tags <tags>", "Filter by tags")
    .action(async (opts) => {
      await listAction({ name: opts.name, tags: opts.tags, serverUrl: opts.serverUrl });
    });

  program
    .command("info <slug>")
    .description("Show detailed skill information (metadata, files, status)")
    .action(async (slug, opts) => {
      await infoAction(slug, { serverUrl: opts.serverUrl });
    });

  program
    .command("search")
    .description("Search skills by name or keyword")
    .requiredOption("--name <name>", "Skill name to search")
    .action(async (opts) => {
      await searchAction(opts.name, { serverUrl: opts.serverUrl });
    });

  program
    .command("remove <slug>")
    .description("Remove a skill and its stored files")
    .option("--force", "Skip confirmation")
    .action(async (slug, opts) => {
      await removeAction(slug, { force: opts.force, serverUrl: opts.serverUrl });
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
        serverUrl: opts.serverUrl as string | undefined,
      });
    });

  program
    .command("versions <slug>")
    .description("Show version history for a skill")
    .option("--show <version>", "Show details for a specific version")
    .action(async (slug, opts) => {
      await versionsAction(slug, { show: opts.show as string | undefined, serverUrl: opts.serverUrl });
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
        serverUrl: opts.serverUrl as string | undefined,
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
    .action(async (slug, opts) => { await evalListAction(slug, { serverUrl: opts.serverUrl }); });

  evalCmd
    .command("run <slug>")
    .description("Run every eval case for a skill against the stub provider, persist results")
    .action(async (slug, opts) => { await evalRunAction(slug, { serverUrl: opts.serverUrl }); });

  evalCmd
    .command("results <slug>")
    .description("Show recent eval runs for a skill")
    .option("--limit <n>", "Max rows to display (default 20)", "20")
    .action(async (slug, opts) => {
      await evalResultsAction(slug, { limit: parseInt(opts.limit as string, 10), serverUrl: opts.serverUrl });
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
    .description("Log in with username and password (local or remote)")
    .action(async (opts) => { await loginAction({ serverUrl: opts.serverUrl }); });

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
      await resetPasswordAction({ username: opts.username, password: opts.password, serverUrl: opts.serverUrl });
    });

  // ── User management ────────────────────────────────────────────────
  const userCmd = program
    .command("user")
    .description("Manage users, tokens, and role assignments");

  userCmd
    .command("list")
    .description("List all users")
    .action(async (opts) => { await userListAction({ serverUrl: opts.serverUrl }); });

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
        serverUrl: opts.serverUrl as string | undefined,
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
        serverUrl: opts.serverUrl as string | undefined,
      });
    });

  userCmd
    .command("get <userId>")
    .description("Get user details")
    .action(async (userId, opts) => { await userGetAction(userId, { serverUrl: opts.serverUrl }); });

  userCmd
    .command("delete <userId>")
    .description("Delete a user")
    .action(async (userId, opts) => { await userDeleteAction(userId, { serverUrl: opts.serverUrl }); });

  userCmd
    .command("assign-roles <userId>")
    .description("Assign roles to a user (replaces existing)")
    .requiredOption("--role-ids <ids>", "Comma-separated role IDs")
    .action(async (userId, opts) => {
      const roleIds = (opts.roleIds as string).split(",").map((s: string) => s.trim());
      await userAssignRolesAction(userId, roleIds, { serverUrl: opts.serverUrl });
    });

  // ── Role management ────────────────────────────────────────────────
  const roleCmd = program
    .command("role")
    .description("Manage roles and permission tags");

  roleCmd
    .command("list")
    .description("List all roles")
    .action(async (opts) => { await roleListAction({ serverUrl: opts.serverUrl }); });

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
        serverUrl: opts.serverUrl as string | undefined,
      });
    });

  roleCmd
    .command("get <roleId>")
    .description("Get role details")
    .action(async (roleId, opts) => { await roleGetAction(roleId, { serverUrl: opts.serverUrl }); });

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
        serverUrl: opts.serverUrl as string | undefined,
      });
    });

  roleCmd
    .command("delete <roleId>")
    .description("Delete a role")
    .action(async (roleId, opts) => { await roleDeleteAction(roleId, { serverUrl: opts.serverUrl }); });

  return program;
}
