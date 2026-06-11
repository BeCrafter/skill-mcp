import { Registry, Counter, Histogram, Gauge } from "prom-client";

export const registry = new Registry();

export const metrics = {
  // MCP tool calls
  mcpToolCalls: new Counter({
    name: "skill_mcp_tool_calls_total",
    help: "Total MCP tool invocations",
    labelNames: ["tool", "status"],
    registers: [registry],
  }),

  // MCP tool latency (per-tool). Buckets tuned for typical local read paths
  // (sub-100ms) up to slow network-backed providers (a few seconds).
  mcpToolDuration: new Histogram({
    name: "skill_mcp_tool_duration_seconds",
    help: "MCP tool invocation duration in seconds",
    labelNames: ["tool", "status"],
    buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),

  // ISkillProvider latency — separates local-fs/cache from remote gateway.
  providerLatency: new Histogram({
    name: "skill_mcp_provider_latency_seconds",
    help: "ISkillProvider operation latency in seconds",
    labelNames: ["provider", "operation", "status"], // provider=local|remote
    buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [registry],
  }),

  // DB query latency. Use a single label so we can tag any repository call
  // site without exploding cardinality on free-form SQL.
  dbQueryDuration: new Histogram({
    name: "skill_mcp_db_query_duration_seconds",
    help: "Database query duration in seconds",
    labelNames: ["repo", "method", "status"],
    buckets: [0.0005, 0.005, 0.025, 0.1, 0.5, 1],
    registers: [registry],
  }),

  // HTTP API requests
  httpRequests: new Counter({
    name: "skill_mcp_http_requests_total",
    help: "Total HTTP API requests",
    labelNames: ["route", "method", "status_code"],
    registers: [registry],
  }),

  // Request duration
  httpDuration: new Histogram({
    name: "skill_mcp_http_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["route"],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [registry],
  }),

  // Cache operations
  cacheOps: new Counter({
    name: "skill_mcp_cache_operations_total",
    help: "Total cache operations",
    labelNames: ["layer", "result"], // layer=l1|l2, result=hit|miss
    registers: [registry],
  }),

  // Skill count
  skillCount: new Gauge({
    name: "skill_mcp_skills_total",
    help: "Total number of skills in database",
    registers: [registry],
  }),

  // Skill imports
  skillImports: new Counter({
    name: "skill_mcp_imports_total",
    help: "Total skill imports",
    labelNames: ["action"], // action=created|updated
    registers: [registry],
  }),

  // Active MCP transport sessions broken down by transport. The reaper sweeps
  // idle sessions every 5 min (T-206) — this gauge tracks the live total so
  // operators can spot leaks (sustained growth) or session storms.
  mcpActiveSessions: new Gauge({
    name: "skill_mcp_active_sessions",
    help: "Active MCP sessions",
    labelNames: ["transport"], // transport=http|sse
    registers: [registry],
  }),

  // Event bus listener latency + error count (T-303). Per-event latency
  // helps spot slow subscribers; error counter is bumped from the bus's
  // try/catch so a single noisy listener doesn't disappear into logs.
  eventListenerDuration: new Histogram({
    name: "skill_mcp_event_listener_duration_seconds",
    help: "Event listener execution duration in seconds",
    labelNames: ["event", "status"], // status=ok|error
    buckets: [0.001, 0.005, 0.025, 0.1, 0.5, 1],
    registers: [registry],
  }),
  eventListenerErrors: new Counter({
    name: "skill_mcp_event_listener_errors_total",
    help: "Total event listener errors",
    labelNames: ["event"],
    registers: [registry],
  }),

  // Permission deny counter (T-303). Tagged by visibility so dashboards
  // can spot a spike of `private` denials (auth misconfig) separately
  // from `internal` (missing role assignment).
  permissionDenials: new Counter({
    name: "skill_mcp_permission_denials_total",
    help: "Total permission filter denials",
    labelNames: ["visibility"], // visibility=public|internal|private
    registers: [registry],
  }),

  // Skill import latency + outcome (T-303). Source label distinguishes
  // local-fs vs git pulls; failure counter is incremented even when the
  // staging-commit pipeline aborts mid-flight.
  importDuration: new Histogram({
    name: "skill_mcp_import_duration_seconds",
    help: "Skill import duration in seconds",
    labelNames: ["source", "status"], // source=local|git, status=ok|error
    buckets: [0.05, 0.25, 1, 5, 30],
    registers: [registry],
  }),
  importFailures: new Counter({
    name: "skill_mcp_import_failures_total",
    help: "Total skill import failures",
    labelNames: ["source", "reason"], // reason=validation|storage|db|unknown
    registers: [registry],
  }),

  // Prompt-injection patterns matched while serving skill content.
  // Increment per-pattern, per-source so dashboards can spot a sudden
  // spike from a single skill or import without grepping logs.
  injectionAlerts: new Counter({
    name: "skill_mcp_injection_alert_total",
    help: "Total prompt injection patterns matched in skill content",
    labelNames: ["pattern", "source"], // source=view|import|lint
    registers: [registry],
  }),

  // Pipeline run rows whose JSON columns failed to parse during hydration
  // (T-501). One row may increment multiple labels if several columns are
  // corrupt. A non-zero count on any label means the row was dropped from
  // findById and the caller treats it as not found.
  pipelineRunRowCorrupted: new Counter({
    name: "skill_mcp_pipeline_runs_row_corrupted_total",
    help: "Pipeline run rows dropped because a JSON column failed to parse",
    labelNames: ["column"], // column=definition|inputs|batches|completedStages
    registers: [registry],
  }),

  // T-403 — FileCacheProvider periodic GC. Tracks how often the GC runs,
  // how many entries it evicts, and how long a sweep takes. Layer label
  // future-proofs the metric for additional storage backends.
  cacheGcRuns: new Counter({
    name: "skill_mcp_cache_gc_runs_total",
    help: "Total cache GC sweeps executed",
    labelNames: ["layer"], // layer=file
    registers: [registry],
  }),
  cacheGcEvicted: new Counter({
    name: "skill_mcp_cache_gc_evicted_total",
    help: "Total cache entries evicted by GC",
    labelNames: ["layer"],
    registers: [registry],
  }),
  cacheGcDuration: new Histogram({
    name: "skill_mcp_cache_gc_duration_seconds",
    help: "Duration of a cache GC sweep in seconds",
    labelNames: ["layer"],
    buckets: [0.005, 0.025, 0.1, 0.5, 1, 5],
    registers: [registry],
  }),

  // T-712 — Role.tags JSON column failed to parse during hydration. Empty
  // tags fail-open for `private` skills with empty tag lists, so a corrupt
  // row would silently widen visibility; this counter (plus a warn log
  // including the role id) makes the corruption observable.
  roleTagsParseErrors: new Counter({
    name: "skill_mcp_role_tags_parse_errors_total",
    help: "Role rows whose tags JSON column failed to parse during hydration",
    registers: [registry],
  }),

  // T-721 — skills.attributes JSON column failed to parse during hydration.
  // Returning the typed-but-wrong-shape array silently breaks every consumer
  // that expects an object; the counter (plus a warn log with the skill id
  // and column) makes corruption observable. Counts per-row, not per-call,
  // so a single bad row that's read N times shows up as N events.
  skillRowJsonParseErrors: new Counter({
    name: "skill_mcp_skill_row_json_parse_errors_total",
    help: "skills.attributes JSON column failed to parse during hydration",
    labelNames: ["column"], // column=attributes
    registers: [registry],
  }),

  // P0-3 — Token-bucket rate limiter denials. Scope distinguishes admin vs
  // gateway pressure so dashboards can flag a noisy admin user separately
  // from a gateway-wide spike.
  rateLimitDenied: new Counter({
    name: "skill_mcp_rate_limit_denied_total",
    help: "Total HTTP requests rejected by the token-bucket rate limiter",
    labelNames: ["scope"], // scope=admin|gateway
    registers: [registry],
  }),

  // P1-13.5 — Quota check denials. Distinct from `rateLimitDenied` (a sliding-
  // window burst protection); a `quota_check_denied_total` increment means
  // the tenant hit a per-tier limit (daily counter or storage cap).
  quotaCheckDenied: new Counter({
    name: "skill_mcp_quota_check_denied_total",
    help: "Total HTTP requests rejected by the per-tenant quota check",
    labelNames: ["scope", "dimension"], // scope=admin|gateway, dimension=api_calls|...
    registers: [registry],
  }),

  // P1-16 — Webhook outbound metrics (review §5.5.1).
  // `webhookDeliveryFinal` captures terminal outcomes for dashboards (success
  // vs dead_letter ratio); `webhookDeliveryRetry` increments when a row is
  // pushed back into pending for another attempt; `webhookDispatchDuration`
  // is the per-attempt POST latency histogram (seconds).
  webhookDeliveryFinal: new Counter({
    name: "skill_mcp_webhook_delivery_final_total",
    help: "Total webhook deliveries that reached a terminal status",
    labelNames: ["outcome"], // outcome=success|dead_letter
    registers: [registry],
  }),

  webhookDeliveryRetry: new Counter({
    name: "skill_mcp_webhook_delivery_retry_total",
    help: "Total webhook deliveries rescheduled for retry",
    labelNames: ["event"],
    registers: [registry],
  }),

  webhookDispatchDuration: new Histogram({
    name: "skill_mcp_webhook_dispatch_duration_seconds",
    help: "Wall-clock time from POST start to HTTP response (or timeout)",
    labelNames: ["event"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  }),

  // P1-13 — Usage metering events recorded. `status=ok` on insert success,
  // `status=error` on DB failure (the request still proceeds — usage write
  // is fire-and-forget). `event_type` is included so dashboards can split
  // skill.view vs pipeline.run vs api.call vs storage.write volume.
  usageEventsRecorded: new Counter({
    name: "skill_mcp_usage_events_total",
    help: "Total usage metering events recorded (or attempted)",
    labelNames: ["event_type", "status"], // status=ok|error
    registers: [registry],
  }),

  // T-605 — cloud-service responses that fail RemoteSkillProvider's zod
  // schema validation. A non-zero count means the gateway and cloud schemas
  // are drifting; UpstreamError is thrown immediately so callers get a clean
  // 502 instead of a deep TypeError.
  remoteValidationErrors: new Counter({
    name: "skill_mcp_remote_validation_errors_total",
    help: "Cloud service responses rejected by RemoteSkillProvider schema validation",
    labelNames: ["method"], // method=listSkills|getSkillMeta|getSkillMetaById|getSkillFiles|getSkillFileTree
    registers: [registry],
  }),
};
