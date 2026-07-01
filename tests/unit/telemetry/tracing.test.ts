/**
 * P0-6 — OpenTelemetry instrumentation tests.
 *
 * We don't boot the full NodeSDK here; that triggers globalThis side-effects
 * that conflict with vitest's parallel runner. Instead we register a
 * BasicTracerProvider with an InMemorySpanExporter via the OTel API and
 * exercise the helpers. The withSpan wrappers go through trace.getTracer(),
 * so this matches what production code does at runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  withSpan,
  withSpanSync,
  activeTraceId,
  ATTR_USER_ID,
  ATTR_SESSION_ID,
} from "../../../src/telemetry/spans.js";
import { tracingOptionsFromEnv, TRACER_NAME } from "../../../src/telemetry/tracing.js";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

function fakeCtx(overrides: Partial<{ userId: string; sessionId: string }> = {}) {
  return {
    userId: overrides.userId ?? "user-y",
    sessionId: overrides.sessionId,
  };
}

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  contextManager.disable();
  context.disable();
  trace.disable();
});

describe("withSpan / withSpanSync", () => {
  it("emits a span with the requested name", async () => {
    await withSpan("test.span", {}, async () => 42);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("test.span");
  });

  it("attaches user_id / session_id from RequestContext", async () => {
    await withSpan("test.span", { ctx: fakeCtx({ sessionId: "sess-1" }) }, async () => undefined);
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes[ATTR_USER_ID]).toBe("user-y");
    expect(span.attributes[ATTR_SESSION_ID]).toBe("sess-1");
  });

  it("omits session_id when not provided", async () => {
    await withSpan("test.span", { ctx: fakeCtx() }, async () => undefined);
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes[ATTR_SESSION_ID]).toBeUndefined();
  });

  it("merges custom attributes alongside context attrs", async () => {
    await withSpan("test.span", { ctx: fakeCtx(), attributes: { "skill.id": "abc" } }, async () => undefined);
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["skill.id"]).toBe("abc");
  });

  it("records exceptions and sets status=ERROR on throw", async () => {
    await expect(withSpan("test.span", {}, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    const span = exporter.getFinishedSpans()[0];
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("boom");
    expect(span.events.find(e => e.name === "exception")).toBeTruthy();
  });

  it("ends spans even when the operation throws (no leaks)", async () => {
    try {
      await withSpan("a", {}, async () => { throw new Error("x"); });
    } catch { /* swallow */ }
    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0].endTime[0]).toBeGreaterThan(0);
  });

  it("withSpanSync returns synchronously and records spans", () => {
    const result = withSpanSync("sync.span", { ctx: fakeCtx() }, () => "ok");
    expect(result).toBe("ok");
    const span = exporter.getFinishedSpans()[0];
    expect(span.name).toBe("sync.span");
  });

  it("withSpanSync records exceptions and rethrows", () => {
    expect(() => withSpanSync("sync.span", {}, () => {
      throw new Error("sync-boom");
    })).toThrow("sync-boom");
    const span = exporter.getFinishedSpans()[0];
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("sync-boom");
  });

  it("creates a parent/child relationship when spans are nested", async () => {
    await withSpan("parent", {}, async () => {
      await withSpan("child", {}, async () => undefined);
    });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const child = spans.find(s => s.name === "child");
    const parent = spans.find(s => s.name === "parent");
    expect(child).toBeDefined();
    expect(parent).toBeDefined();
    expect(child!.parentSpanContext?.spanId).toBe(parent!.spanContext().spanId);
  });
});

describe("activeTraceId", () => {
  it("returns null when no span is active", () => {
    expect(activeTraceId()).toBeNull();
  });

  it("returns the W3C trace_id of the active span", async () => {
    let captured: unknown = null;
    await withSpan("test.span", {}, async () => {
      captured = activeTraceId();
    });
    expect(typeof captured).toBe("string");
    expect(captured as string).toMatch(/^[a-f0-9]{32}$/);
  });

  it("returns null outside of any span context", () => {
    context.with(context.active(), () => {
      expect(activeTraceId()).toBeNull();
    });
  });
});

describe("tracingOptionsFromEnv", () => {
  it("disables tracing by default", () => {
    const opts = tracingOptionsFromEnv({});
    expect(opts.enabled).toBe(false);
  });

  it("enables tracing when OTEL_ENABLED=true", () => {
    const opts = tracingOptionsFromEnv({ OTEL_ENABLED: "true" });
    expect(opts.enabled).toBe(true);
  });

  it("treats any other value as disabled", () => {
    expect(tracingOptionsFromEnv({ OTEL_ENABLED: "1" }).enabled).toBe(false);
    expect(tracingOptionsFromEnv({ OTEL_ENABLED: "yes" }).enabled).toBe(false);
    expect(tracingOptionsFromEnv({ OTEL_ENABLED: "" }).enabled).toBe(false);
  });

  it("propagates endpoint, service name, and service version", () => {
    const opts = tracingOptionsFromEnv({
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318",
      OTEL_SERVICE_NAME: "skill-mcp-test",
      OTEL_SERVICE_VERSION: "9.9.9",
    });
    expect(opts.endpoint).toBe("http://otel:4318");
    expect(opts.serviceName).toBe("skill-mcp-test");
    expect(opts.serviceVersion).toBe("9.9.9");
  });

  it("exports a stable tracer name", () => {
    expect(TRACER_NAME).toBe("skill-mcp");
  });
});
