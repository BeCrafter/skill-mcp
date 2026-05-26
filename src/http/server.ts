import type { IncomingMessage, ServerResponse } from "node:http";
import { json, parseQuery, RequestBodyTooLargeError } from "./helpers.js";
import { attachRequestId } from "./middleware/request-id.js";
import { enforceGatewayAuth } from "./middleware/gateway-auth.js";
import { enforceAdminAuth } from "./middleware/admin-auth.js";
import { metrics, registry } from "../telemetry/metrics.js";
import { getLogger } from "../utils/logger.js";
import type { Router } from "./router.js";
import type { HttpContext } from "./context.js";
import type { AppConfig } from "../config/schema.js";
import type { UserRepository } from "../db/repositories/user.repository.js";
import type { UserRoleRepository } from "../db/repositories/user-role.repository.js";

export interface RequestHandlerDeps {
  appConfig: AppConfig;
  mcpHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null;
  isCloudServiceOnlyMode: boolean;
  adminRouter: Router;
  gatewayRouter: Router;
  userRepo?: UserRepository;
  userRoleRepo?: UserRoleRepository;
}

// Translates the raw http.Server `request` event into router dispatch with
// auth, metrics, and security headers. Lifted out of app.ts (T-301) so the
// dispatch path can be unit-tested without booting the full server.
export function createRequestHandler(deps: RequestHandlerDeps) {
  const logger = getLogger();
  const { appConfig, mcpHandler, isCloudServiceOnlyMode, adminRouter, gatewayRouter } = deps;

  // Constant Prometheus label for any path that does not match a registered
  // route. Without this, every fuzzed/scanned URL (`/wp-admin`, `/.env`, …)
  // becomes a unique `route` label that prom-client retains forever, which
  // is the classic high-cardinality OOM footgun on internet-facing exposure.
  const UNMATCHED_ROUTE_LABEL = "__not_matched__";

  function recordMetrics(route: string, method: string, statusCode: number, startTime: number) {
    const duration = (Date.now() - startTime) / 1000;
    metrics.httpRequests.inc({ route, method, status_code: statusCode });
    metrics.httpDuration.observe({ route }, duration);
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const startTime = Date.now();
    const requestId = attachRequestId(req, res);

    // Baseline security response headers applied to every response. Set early
    // so they survive both json() helper writes and writeHead() calls inside
    // route handlers / MCP transports. HSTS is gated behind `security.hstsEnabled`
    // (env: SECURITY_HSTS_ENABLED): emitting it from a server without TLS
    // termination pins browsers to HTTPS and breaks plain-HTTP access.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (appConfig.security.hstsEnabled) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    res.setHeader("Cache-Control", "no-store");

    try {
      const url = req.url?.split("?")[0] ?? "";

      if (url === "/mcp" || url === "/mcp/sse" || url === "/mcp/messages") {
        if (mcpHandler) { await mcpHandler(req, res); return; }
        if (isCloudServiceOnlyMode) { json(res, 403, { error: "MCP not available in cloud mode" }); return; }
      }

      if (appConfig.transport.mcpOnlyMode) { json(res, 404, { error: "Not found (MCP-only mode)" }); return; }

      if (url === "/metrics") {
        // T-707 — Prometheus exposition leaks route names, MCP session counts,
        // cache hit rates, and user/role tallies. Default-secure: gate behind
        // admin-tag bearer (same gate as `/api/admin/*`); operators can opt
        // back into anonymous scrape via SKILL_MCP_METRICS_AUTH_OPTIONAL=true.
        if (!appConfig.auth.metricsAuthOptional) {
          const ctx: HttpContext = { req, res, url, method: req.method!, params: {}, query: parseQuery(req.url ?? "/", req.headers.host), logger };
          const requestContext = await enforceAdminAuth(ctx, {
            userRepo: deps.userRepo,
            userRoleRepo: deps.userRoleRepo,
            authOptional: false,
          });
          if (!requestContext) {
            recordMetrics(url, req.method!, res.statusCode, startTime);
            return;
          }
        }
        const metricsData = await registry.metrics();
        res.writeHead(200, { "Content-Type": registry.contentType });
        res.end(metricsData);
        recordMetrics(url, req.method!, 200, startTime);
        return;
      }

      if (url === "/api/health") { json(res, 200, { status: "ok", timestamp: new Date().toISOString() }); return; }

      // Gateway routes — token enforced by enforceGatewayAuth middleware before dispatch.
      // /api/gateway/health is the only anonymous-accessible endpoint (LB / k8s probes).
      if (url.startsWith("/api/gateway/")) {
        const match = gatewayRouter.match(req.method!, url);
        if (match) {
          const ctx: HttpContext = { req, res, url, method: req.method!, params: match.params, query: parseQuery(req.url ?? "/", req.headers.host), logger };
          if (url !== "/api/gateway/health") {
            const requestContext = await enforceGatewayAuth(ctx, deps);
            if (!requestContext) {
              recordMetrics(url, req.method!, res.statusCode, startTime);
              return;
            }
            ctx.requestContext = requestContext;
          }
          await gatewayRouter.dispatch(ctx);
          recordMetrics(url, req.method!, res.statusCode, startTime);
          return;
        }
      }

      // Admin routes — enforce admin-tag-gated bearer auth before dispatch.
      // Legacy deployments can opt back in to anonymous admin via
      // SKILL_MCP_ADMIN_AUTH_OPTIONAL=true (see config.auth.adminAuthOptional).
      if (url.startsWith("/api/admin/")) {
        const match = adminRouter.match(req.method!, url);
        if (match) {
          const ctx: HttpContext = { req, res, url, method: req.method!, params: match.params, query: parseQuery(req.url ?? "/", req.headers.host), logger };
          const requestContext = await enforceAdminAuth(ctx, {
            userRepo: deps.userRepo,
            userRoleRepo: deps.userRoleRepo,
            authOptional: appConfig.auth.adminAuthOptional,
          });
          if (!requestContext) {
            recordMetrics(url, req.method!, res.statusCode, startTime);
            return;
          }
          ctx.requestContext = requestContext;
          await adminRouter.dispatch(ctx);
          recordMetrics(url, req.method!, res.statusCode, startTime);
          return;
        }
      }

      json(res, 404, { error: "Not found" });
      recordMetrics(UNMATCHED_ROUTE_LABEL, req.method!, 404, startTime);
    } catch (err) {
      // Use the unmatched-route bucket here too: at this point we don't
      // know whether the URL would have matched a route, and exposing the
      // raw URL as a metrics label is what we're guarding against.
      if (err instanceof RequestBodyTooLargeError) {
        if (!res.headersSent) { json(res, 413, { error: "Payload too large", limit: err.limit }); }
        recordMetrics(UNMATCHED_ROUTE_LABEL, req.method!, 413, startTime);
        return;
      }
      logger.error({ err, url: req.url, requestId }, "Request handler error");
      if (!res.headersSent) { json(res, 500, { error: "Internal server error" }); }
      recordMetrics(UNMATCHED_ROUTE_LABEL, req.method!, 500, startTime);
    }
  };
}
