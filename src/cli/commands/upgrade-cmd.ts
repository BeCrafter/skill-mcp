import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { getConfig } from "../../config/index.js";
import { c, ok, warn, fail, kv } from "../ui.js";

// ── Constants ──────────────────────────────────────────────────────────

const REGISTRIES = [
  "https://registry.npmjs.org/skill-mcp/latest",
  "https://registry.npmmirror.com/skill-mcp/latest",
];


const SUPPORTED_PMS = ["npm", "pnpm", "yarn", "bun"] as const;
type PackageManager = (typeof SUPPORTED_PMS)[number];

// ── Version fetching ────────────────────────────────────────────────────

async function fetchLatestVersion(): Promise<string | null> {
  for (const url of REGISTRIES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;

        const data = (await res.json()) as { version: string };
        return data.version;
      } catch {
        /* retry next */
      }
    }
  }
  return null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// ── Package manager detection ───────────────────────────────────────────

function detectPackageManager(): PackageManager {
  const envPm = process.env.SKILL_MCP_PKG_MANAGER;
  if (envPm && (SUPPORTED_PMS as readonly string[]).includes(envPm)) {
    return envPm as PackageManager;
  }

  for (const pm of SUPPORTED_PMS) {
    try {
      execSync(`command -v ${pm}`, { stdio: "pipe" });
      return pm;
    } catch {
      /* not found, try next */
    }
  }

  return "npm";
}

function buildUpgradeCommand(pm: PackageManager): string {
  switch (pm) {
    case "npm":
      return "npm install -g skill-mcp@latest";
    case "pnpm":
      return "pnpm add -g skill-mcp@latest";
    case "yarn":
      return "yarn global add skill-mcp@latest";
    case "bun":
      return "bun install -g skill-mcp@latest";
  }
}

// ── Upgrade strategies ──────────────────────────────────────────────────

/** npm staged install: temp install → verify → atom swap. */
function npxStagedInstall(latestVersion: string): string | null {
  const tmpDirPath = join(tmpdir(), `skill-mcp-upgrade-${Date.now()}-${process.pid}`);

  // 1. Install to temp directory
  try {
    execSync(`npm install --prefix "${tmpDirPath}" --no-save skill-mcp@${latestVersion}`, {
      stdio: "inherit",
      timeout: 120_000,
    });
  } catch {
    rmSync(tmpDirPath, { recursive: true, force: true });
    fail(`Failed to install skill-mcp@${latestVersion} to temp directory`);
    return null;
  }

  // 2. Verify
  const pkgPath = join(tmpDirPath, "node_modules", "skill-mcp", "package.json");
  if (!existsSync(pkgPath)) {
    rmSync(tmpDirPath, { recursive: true, force: true });
    fail("Verification failed: installed package has no package.json");
    return null;
  }

  try {
    const pkgJson = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    if (pkgJson.version !== latestVersion) {
      rmSync(tmpDirPath, { recursive: true, force: true });
      fail(`Version mismatch: expected ${latestVersion}, got ${pkgJson.version}`);
      return null;
    }
  } catch (err) {
    rmSync(tmpDirPath, { recursive: true, force: true });
    fail(`Failed to read package.json: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // 3. Atom swap: backup old → move new → delete backup (or rollback)
  let globalRoot: string;
  try {
    globalRoot = execSync("npm root -g", { encoding: "utf-8", timeout: 5_000 }).trim();
  } catch {
    rmSync(tmpDirPath, { recursive: true, force: true });
    fail("Failed to determine global node_modules path (npm root -g)");
    return null;
  }

  const targetDir = join(globalRoot, "skill-mcp");
  const backupDir = join(globalRoot, "skill-mcp.bak");
  const newPackageDir = join(tmpDirPath, "node_modules", "skill-mcp");

  // Clean up stale backup if it exists (previous crash recovery)
  if (existsSync(backupDir)) {
    rmSync(backupDir, { recursive: true, force: true });
  }

  // Rename old → backup (best-effort, might not exist on fresh install)
  let hasOld = false;
  if (existsSync(targetDir)) {
    hasOld = true;
    try {
      execSync(`mv "${targetDir}" "${backupDir}"`, { stdio: "pipe", timeout: 10_000 });
    } catch (err) {
      rmSync(tmpDirPath, { recursive: true, force: true });
      const msg = err instanceof Error ? err.message : String(err);
      fail(`Failed to backup current install: ${msg}`);
      return null;
    }
  }

  // Move new → target
  try {
    execSync(`mv "${newPackageDir}" "${targetDir}"`, { stdio: "pipe", timeout: 10_000 });
  } catch (err) {
    // Rollback: restore backup
    if (hasOld && existsSync(backupDir)) {
      try {
        execSync(`mv "${backupDir}" "${targetDir}"`, { stdio: "pipe" });
      } catch {
        fail("Upgrade failed AND rollback failed.");
        runHint("Reinstall manually:", buildUpgradeCommand(detectPackageManager()));
        rmSync(tmpDirPath, { recursive: true, force: true });
        return null;
      }
    }
    rmSync(tmpDirPath, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EACCES") || msg.includes("EPERM")) {
      fail("Permission denied. Try running with sudo, or upgrade manually:");
    } else {
      fail(`Failed to swap package: ${msg}`);
    }
    return null;
  }

  // Success — delete backup and temp directory
  if (existsSync(backupDir)) {
    rmSync(backupDir, { recursive: true, force: true });
  }
  rmSync(tmpDirPath, { recursive: true, force: true });

  return latestVersion;
}

/** Direct install for pnpm/yarn/bun. */
function directInstall(pm: PackageManager): boolean {
  const command = buildUpgradeCommand(pm);
  try {
    execSync(command, { stdio: "inherit", timeout: 120_000 });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EACCES") || msg.includes("EPERM")) {
      fail("Permission denied. Try running with sudo, or upgrade manually:");
    }
    return false;
  }
}

// ── Confirmation ────────────────────────────────────────────────────────

async function confirmUpgrade(
  current: string,
  latest: string,
  pm: PackageManager,
  autoYes: boolean,
): Promise<boolean> {
  if (autoYes || !process.stdout.isTTY) return true;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\n  Upgrade skill-mcp from ${c.dim(current)} to ${c.boldGreen(latest)} using ${c.cyan(pm)}? [Y/n] `,
  );
  rl.close();
  if (answer.toLowerCase() === "n") return false;
  return true;
}

// ── Legend ──────────────────────────────────────────────────────────────

function runHint(label: string, command: string, note?: string): void {
  const line = `  ${c.dim("→")}  ${label}  ${c.cyan(command)}`;
  console.log(note ? line + `  ${c.dim(note)}` : line);
}

// ── Main action ─────────────────────────────────────────────────────────

export async function upgradeAction(options: {
  dryRun?: boolean;
  yes?: boolean;
} = {}): Promise<void> {
  const config = getConfig();
  const current = config.app.version;

  console.log(`\n  ${c.bold("UPGRADE")}`);
  console.log(`  ${c.dim("─".repeat(40))}`);
  console.log();
  console.log(kv("current", current));

  const latest = await fetchLatestVersion();

  if (!latest) {
    warn("Could not check for updates. Check your network connection.");
    return;
  }

  console.log(kv("latest", c.cyan(latest)));

  if (compareVersions(latest, current) <= 0) {
    console.log();
    ok("Already on the latest version");
    return;
  }

  console.log();

  warn(`${c.bold("New version available:")}  ${c.dim(current)}  →  ${c.boldGreen(latest)}`);

  if (options.dryRun) {
    const pm = detectPackageManager();
    console.log();
    console.log(kv("package manager", c.cyan(pm)));
    runHint("Run", buildUpgradeCommand(pm), "(to upgrade)");
    console.log();
    return;
  }

  const pm = detectPackageManager();
  console.log(kv("package manager", c.cyan(pm)));

  const confirmed = await confirmUpgrade(current, latest, pm, options.yes ?? false);
  if (!confirmed) {
    warn("Upgrade cancelled.");
    return;
  }

  console.log();

  if (pm === "npm") {
    const installed = npxStagedInstall(latest);
    if (!installed) {
      process.exit(1);
    }
    console.log();
    ok(`${c.bold("Upgraded")}  →  ${c.boldGreen(`v${installed}`)}`);
  } else {
    const success = directInstall(pm);
    if (!success) {
      process.exit(1);
    }
    console.log();
    ok(`${c.bold("Upgraded")}  ${c.dim("→")}  ${c.boldGreen(`v${latest}`)}`);
  }
  console.log();
}
