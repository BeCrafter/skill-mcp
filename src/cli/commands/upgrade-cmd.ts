import { getConfig } from "../../config/index.js";
import { c, ok, warn, kv, hint, section } from "../ui.js";

const REGISTRIES = [
  "https://registry.npmjs.org/skill-mcp/latest",
  "https://registry.npmmirror.com/skill-mcp/latest",
];

async function fetchLatestVersion(): Promise<string | null> {
  for (const url of REGISTRIES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const data = await res.json() as { version: string };
        return data.version;
      } catch { /* retry next */ }
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

export async function upgradeAction(): Promise<void> {
  const config = getConfig();
  const current = config.app.version;

  console.log(section("Checking for updates"));
  console.log();
  console.log(kv("current", current));

  const latest = await fetchLatestVersion();

  if (!latest) {
    warn("Could not check for updates. Check your network connection.");
    return;
  }

  console.log(kv("latest", c.cyan(latest)));

  if (compareVersions(latest, current) <= 0) {
    ok("Already on the latest version");
    return;
  }

  console.log();
  warn("A newer version is available");
  console.log(kv("current", current));
  console.log(kv("latest", c.green(latest)));
  console.log();
  hint(`Run ${c.cyan("npm i -g skill-mcp@latest")} to upgrade`);
  console.log();
}
