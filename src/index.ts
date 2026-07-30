#!/usr/bin/env node
import { createCli } from "./cli/index.js";

async function main(): Promise<void> {
  const cli = await createCli();
  await cli.parseAsync(process.argv);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
