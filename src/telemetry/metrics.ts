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
};
