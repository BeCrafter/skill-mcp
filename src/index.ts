#!/usr/bin/env node
import { getConfig } from "./config/index.js";
import { createCli } from "./cli/index.js";

async function main(): Promise<void> {
  const config = getConfig();

  // If no arguments, default to serve
  if (process.argv.length <= 2) {
    process.argv.push("serve", "--transport", config.transport.type);
  }

  const cli = await createCli();
  await cli.parseAsync(process.argv);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
