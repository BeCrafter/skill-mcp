import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_PATH = join(homedir(), ".skill-mcp", "config.json");

export interface LocalConfig {
  jwt_secret: string;
}

export function saveLocalConfig(config: LocalConfig): void {
  const dir = join(homedir(), ".skill-mcp");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}
