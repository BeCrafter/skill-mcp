/**
 * P0-6 — OpenTelemetry SDK bootstrap.
 *
 * Manual instrumentation only (no auto-instrumentation): we wire spans at the
 * exact boundaries spec'd in commercialization-review §17.6 and avoid the
 * cardinality / startup-cost surface that comes with the auto-instrumented
 * Node modules.
 *
 * Calling code obtains a tracer via `getTracer()`. The OpenTelemetry API is
 * a no-op when no SDK is registered, so `withSpan(...)` is safe to call
 * regardless of whether `initTracing()` ran. This means OTel is opt-in via
 * `OTEL_ENABLED=true` and zero overhead by default.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ConsoleSpanExporter, SimpleSpanProcessor, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { trace, type Tracer } from "@opentelemetry/api";
import { createRequire } from "node:module";

const APP_VERSION = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

export interface TracingOptions {
  /** When false, this is a no-op — useful for tests / dev where the SDK is undesired. */
  enabled: boolean;
  /** OTLP endpoint URL (HTTP). When unset, falls back to ConsoleSpanExporter. */
  endpoint?: string;
  /** Service name attribute (default: skill-mcp). */
  serviceName?: string;
  /** Service version attribute (default: package.json version). */
  serviceVersion?: string;
  /** Use a SimpleSpanProcessor (immediate flush, helpful in tests / one-shot CLI). */
  simpleProcessor?: boolean;
}

let sdkInstance: NodeSDK | null = null;
let started = false;

export const TRACER_NAME = "skill-mcp";

export function initTracing(options: TracingOptions): void {
  if (!options.enabled) return;
  if (started) return;

  const exporter = options.endpoint
    ? new OTLPTraceExporter({ url: options.endpoint })
    : new ConsoleSpanExporter();

  const processor: SpanProcessor = options.simpleProcessor
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(exporter);

  sdkInstance = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName ?? "skill-mcp",
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? APP_VERSION,
    }),
    spanProcessors: [processor],
  });

  sdkInstance.start();
  started = true;
}

export async function shutdownTracing(): Promise<void> {
  if (!sdkInstance) return;
  try {
    await sdkInstance.shutdown();
  } finally {
    sdkInstance = null;
    started = false;
  }
}

/** Returns the project's tracer. Safe to call even before initTracing(). */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** Visible for tests so they can hot-swap the SDK without leaking globals. */
export function isTracingStarted(): boolean {
  return started;
}

/**
 * Build TracingOptions from the current environment.
 *
 *   OTEL_ENABLED=true                 → enable SDK
 *   OTEL_EXPORTER_OTLP_ENDPOINT=...   → OTLP URL (otherwise stdout)
 *   OTEL_SERVICE_NAME=...             → resource service.name
 *   OTEL_SERVICE_VERSION=...          → resource service.version
 */
export function tracingOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): TracingOptions {
  return {
    enabled: env.OTEL_ENABLED === "true",
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: env.OTEL_SERVICE_NAME,
    serviceVersion: env.OTEL_SERVICE_VERSION,
  };
}
