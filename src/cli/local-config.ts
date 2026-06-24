import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_PATH = join(homedir(), ".skill-mcp", "config.json");

export interface LocalConfig {
  jwt_secret: string;
}

export function readLocalConfig(): LocalConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as LocalConfig;
  } catch {
    return null;
  }
}

export function saveLocalConfig(config: LocalConfig): void {
  const dir = join(homedir(), ".skill-mcp");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}
