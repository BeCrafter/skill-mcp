#!/usr/bin/env node
import { getConfig } from "./config/index.js";
import { createCli } from "./cli/index.js";
import { initTracing, shutdownTracing, tracingOptionsFromEnv } from "./telemetry/tracing.js";

async function main(): Promise<void> {
  // P0-6 — initialize OpenTelemetry SDK before anything else when enabled.
  // No-op when OTEL_ENABLED!=true; the in-code spans then run against the
  // OTel API's no-op tracer with zero overhead.
  initTracing(tracingOptionsFromEnv(process.env));
  process.once("SIGTERM", () => { void shutdownTracing(); });
  process.once("SIGINT", () => { void shutdownTracing(); });

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
