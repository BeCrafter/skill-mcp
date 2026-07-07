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
import { syncCheckAction, syncCheckAllAction, syncPullAction } from "./commands/sync-cmd.js";
import { upgradeAction } from "./commands/upgrade-cmd.js";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g;
function visLen(s: string): number { return s.replace(ANSI_RE, "").length; }
function padTo(s: string, width: number): string { return s + " ".repeat(Math.max(0, width - visLen(s))); }

/** Colorize a usage string with level-specific colors. */
function styleUsage(raw: string, level: 1 | 2 | 3 = 1): string {
  const argColor   = level === 1 ? c.yellow    : c.dimYellow;
  const bracketColor = c.dim; // same for all levels
  return raw
    .replace(/\[options\]/g, bracketColor("[options]"))
    .replace(/<[^>]+>/g, m => argColor(m))
    .replace(/\[command\]/g, bracketColor("[command]"));
}

/** Command name color by level. */
function cmdColor(name: string, level: 1 | 2 | 3): string {
  switch (level) {
    case 1: return c.boldGreen(name);
    case 2: return c.green(name);
    case 3: return c.dimGreen(name);
  }
}

/** Build usage string for a command, stripping [options] if none exist. */
function usageOf(cmd: Command): string {
  const raw = cmd.usage();
  const hasOpts = cmd.options.filter(o => o.flags !== "-h, --help").length > 0;
  const cleaned = hasOpts ? raw : raw.replace(/\[options\]\s*/g, "").trim();
  return cmd.name() + (cleaned ? " " + cleaned : "");
}

/** Format a single command row with aligned description. */
function cmdRow(name: string, desc: string, indent: number, colWidth: number): string {
  const styled = styleUsage(name, 1);
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
            { label: "Skills",       icon: "◆", names: ["list", "search", "info", "import", "update", "versions", "rollback", "remove", "lint", "sync"] },
            { label: "Admin",        icon: "◆", names: ["auth", "user", "role"] },
            { label: "Tools",        icon: "◆", names: ["migrate:check", "manifest:migrate"] },
          ];


          const allCmds = subs;
          const used = new Set<string>();

          // Hidden experimental commands
          for (const name of ["eval", "pipeline"]) used.add(name);

          // Options
          if (opts.length > 0) {
            lines.push(`  ${c.bold("OPTIONS")}`);
            for (const o of opts) lines.push(optRow(o.flags, o.description ?? "", 4));
            lines.push("");
          }

          // Flat commands (no group heading)
          const flatNames = ["init", "serve", "upgrade"];
          const flatCmds = allCmds
            .filter(s => flatNames.includes(s.name()))
            .sort((a, b) => flatNames.indexOf(a.name()) - flatNames.indexOf(b.name()));
          if (flatCmds.length > 0) {
            for (const sub of flatCmds) {
              used.add(sub.name());
              const cn = sub.name();
              const rawArgs = sub.usage().replace(/\[options\]\s*/g, "").trim();
              const fullDisplay = rawArgs
                ? `${cmdColor(cn, 1)} ${styleUsage(rawArgs, 1)}`
                : cmdColor(cn, 1);
              const plainLen = cn.length + (rawArgs ? 1 + rawArgs.length : 0);
              lines.push(`  ${fullDisplay}${" ".repeat(Math.max(1, 24 - plainLen))}${c.dim(sub.description())}`);
            }
            lines.push("");
          }

          // Categories
          for (const cat of CATEGORIES) {
            const cmds = allCmds
              .filter(s => cat.names.includes(s.name()))
              .sort((a, b) => cat.names.indexOf(a.name()) - cat.names.indexOf(b.name()));
            if (cmds.length === 0) continue;
            lines.push(`  ${cat.label === "Experimental" ? c.boldYellow(cat.label.toUpperCase()) : c.bold(cat.label.toUpperCase())}`);
            for (const sub of cmds) {
              used.add(sub.name());
              const cn = sub.name();
              const rawArgs = sub.usage().replace(/\[options\]\s*/g, "").trim();
              const fullDisplay = rawArgs
                ? `${cmdColor(cn, 1)} ${styleUsage(rawArgs, 1)}`
                : cmdColor(cn, 1);
              const plainLen = cn.length + (rawArgs ? 1 + rawArgs.length : 0);
              lines.push(`    ${fullDisplay}${" ".repeat(Math.max(1, 24 - plainLen))}${c.dim(sub.description())}`);
            }
            lines.push("");
          }

          // Uncategorized
          const rest = allCmds.filter(s => !used.has(s.name()));
          if (rest.length > 0) {
            lines.push(`  ${c.bold("OTHER")}`);
            for (const sub of rest) {
              const usage = usageOf(sub);
              lines.push(cmdRow("  " + usage, sub.description() ?? "", 4, 36));
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
            const cn = s.name();
            const rawArgs = usageOf(s).replace(cn, "").replace(/\[options\]\s*/g, "").trim();
            const fullDisplay = rawArgs
              ? `${cmdColor(cn, 2)} ${styleUsage(rawArgs, 2)}`
              : cmdColor(cn, 2);
            const plainLen = cn.length + (rawArgs ? 1 + rawArgs.length : 0);
            lines.push("    " + fullDisplay + " ".repeat(Math.max(1, 36 - plainLen)) + c.dim(s.description() ?? ""));
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
          const rawArgs = cmd.usage() || "";
          const hasOpts = opts.length > 0;
          const args = hasOpts ? rawArgs : rawArgs.replace(/\[options\]\s*/g, "").trim();
          lines.push(`  ${c.dim("Usage:")}  ${c.dimCyan(parentName + " " + cmd.name())} ${styleUsage(args, 3)}`.trimEnd());
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
    .description("Start MCP server")
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
    .description("Import skill from local path or Git repo")
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
    .description("List all skills")
    .option("--tags <tags>", "Filter by tags")
    .option("--name <name>", "Filter by name")
    .action(async (opts) => {
      await listAction({ name: opts.name, tags: opts.tags, serverUrl: opts.serverUrl });
    });

  program
    .command("info <slug>")
    .description("Show skill details")
    .action(async (slug, opts) => {
      await infoAction(slug, { serverUrl: opts.serverUrl });
    });

  program
    .command("search")
    .description("Search skills by name")
    .requiredOption("--name <name>", "Skill name to search")
    .action(async (opts) => {
      await searchAction(opts.name, { serverUrl: opts.serverUrl });
    });

  program
    .command("remove <slug>")
    .description("Remove a skill")
    .option("--force", "Skip confirmation")
    .action(async (slug, opts) => {
      await removeAction(slug, { force: opts.force, serverUrl: opts.serverUrl });
    });

  program
    .command("update <slug>")
    .description("Update skill metadata")
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
    .description("Show version history")
    .option("--show <version>", "Show details for a specific version")
    .option("--diff <range>", "Compare two versions (e.g. 1.0.0..1.1.0)")
    .action(async (slug, opts) => {
      await versionsAction(slug, { show: opts.show as string | undefined, diff: opts.diff as string | undefined, serverUrl: opts.serverUrl });
    });

  program
    .command("rollback <slug>")
    .description("Roll back to a previous version")
    .requiredOption("--to <version>", "Target version to rollback to")
    .action(async (slug, opts) => {
      await rollbackAction(slug, {
        to: opts.to as string,
        serverUrl: opts.serverUrl as string | undefined,
      });
    });

  // ── Sync commands ──────────────────────────────────────────────────
  const syncCmd = program.command("sync").description("Sync skills with remote sources");

  syncCmd
    .command("check [slug]")
    .description("Check for remote updates")
    .option("--all", "Check all remote skills")
    .action(async (slug, opts) => {
      if (opts.all || !slug) {
        await syncCheckAllAction({ serverUrl: opts.serverUrl as string | undefined });
      } else {
        await syncCheckAction(slug, { serverUrl: opts.serverUrl as string | undefined });
      }
    });

  syncCmd
    .command("pull <slug>")
    .description("Pull updates from remote")
    .action(async (slug, opts) => {
      await syncPullAction(slug, { serverUrl: opts.serverUrl as string | undefined });
    });

  program
    .command("lint <path>")
    .description("Validate skill package")
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
    .option("--apply", "Rewrite SKILL.md files in place (default: dry-run)")
    .option("--patch", "Emit unified diff to stdout (suitable for git apply)")
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
    .description("[EXPERIMENTAL] Manage skill evaluation")

  evalCmd
    .command("list <slug>")
    .description("List eval cases")
    .action(async (slug, opts) => { await evalListAction(slug, { serverUrl: opts.serverUrl }); });

  evalCmd
    .command("run <slug>")
    .description("Run eval cases")
    .action(async (slug, opts) => { await evalRunAction(slug, { serverUrl: opts.serverUrl }); });

  evalCmd
    .command("results <slug>")
    .description("Show eval results")
    .option("--limit <n>", "Max rows to display (default 20)", "20")
    .action(async (slug, opts) => {
      await evalResultsAction(slug, { limit: parseInt(opts.limit as string, 10), serverUrl: opts.serverUrl });
    });

  // ── System initialization ──────────────────────────────────────────
  program
    .command("init")
    .description("Initialize system")
    .requiredOption("--username <username>", "Superadmin username")
    .requiredOption("--password <password>", "Superadmin password (min 8 chars)")
    .action(async (opts) => {
      await initAction({ username: opts.username, password: opts.password });
    });

  // =========================================================
  // Upgrade command
  // =========================================================
  program
    .command("upgrade")
    .description("Check for a newer version and upgrade skill-mcp")
    .option("--dry-run", "Only check for updates without upgrading")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (opts) => {
      await upgradeAction({
        dryRun: opts.dryRun as boolean | undefined,
        yes: opts.yes as boolean | undefined,
      });
    });

  // ── Auth commands ─────────────────────────────────────────────────
  const authCmd = program
    .command("auth")
    .description("Manage authentication")

  authCmd
    .command("login")
    .description("Log in")
    .action(async (opts) => { await loginAction({ serverUrl: opts.serverUrl }); });

  authCmd
    .command("logout")
    .description("Log out")
    .action(async () => { await logoutAction(); });

  authCmd
    .command("whoami")
    .description("Show current user")
    .action(async () => { await whoamiAction(); });

  authCmd
    .command("reset-password")
    .description("Reset user password")
    .requiredOption("--username <username>", "Username")
    .requiredOption("--password <password>", "New password (min 8 chars)")
    .action(async (opts) => {
      await resetPasswordAction({ username: opts.username, password: opts.password, serverUrl: opts.serverUrl });
    });

  // ── User management ────────────────────────────────────────────────
  const userCmd = program
    .command("user")
    .description("Manage users")

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
    .description("Rotate user token")
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
    .description("Assign roles to user")
    .requiredOption("--role-ids <ids>", "Comma-separated role IDs")
    .action(async (userId, opts) => {
      const roleIds = (opts.roleIds as string).split(",").map((s: string) => s.trim());
      await userAssignRolesAction(userId, roleIds, { serverUrl: opts.serverUrl });
    });

  // ── Role management ────────────────────────────────────────────────
  const roleCmd = program
    .command("role")
    .description("Manage roles")

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
