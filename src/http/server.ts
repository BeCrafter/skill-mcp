import type { IncomingMessage, ServerResponse } from "node:http";
import { json, parseQuery, RequestBodyTooLargeError } from "./helpers.js";
import { getOpenApiSpec } from "./openapi/spec.js";
import { renderSwaggerUiHtml } from "./openapi/swagger-ui.js";
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
import type { SkillRepository } from "../db/repositories/skill.repository.js";
import type { UsageMeterService } from "../services/usage-meter.service.js";
import { checkLiveness, checkReadiness } from "./probes.js";

export interface RequestHandlerDeps {
  appConfig: AppConfig;
  mcpHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null;
  isCloudServiceOnlyMode: boolean;
  adminRouter: Router;
  gatewayRouter: Router;
  userRepo?: UserRepository;
  userRoleRepo?: UserRoleRepository;
  skillRepo?: SkillRepository;
  usageMeter?: UsageMeterService;
  jwtSecret?: string;
  jwtIssuer?: string;
  authRouter?: Router;
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

  // P0-1 — API versioning. `/api/v1/*` is the canonical prefix; the unversioned
  // `/api/admin/*` and `/api/gateway/*` paths remain functional aliases for a
  // 6-month deprecation window per RFC 8594 (Sunset header) + review §14.2.
  // After 2026-11-28 the legacy aliases are slated for removal.
  const LEGACY_SUNSET_DATE = "Sat, 28 Nov 2026 00:00:00 GMT";

  function emitDeprecationHeaders(res: ServerResponse, canonical: string) {
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", LEGACY_SUNSET_DATE);
    res.setHeader("Link", `<${canonical}>; rel="successor-version"`);
  }

  function recordMetrics(route: string, method: string, statusCode: number, startTime: number, ctx?: HttpContext) {
    const duration = (Date.now() - startTime) / 1000;
    metrics.httpRequests.inc({ route, method, status_code: statusCode });
    metrics.httpDuration.observe({ route }, duration);
    // P1-13 — usage metering. Fire-and-forget; rejected requests count too
    // because billing for "calls made" includes 4xx/5xx ratio (the metadata
    // carries status_code so partition queries can split if needed).
    // Skip the unmatched-route bucket so fuzzed `/wp-admin` hits don't inflate
    // the metering ledger. Skip /metrics to avoid feedback loops where a
    // Prometheus scrape registers as an api.call.
    if (deps.usageMeter && route !== UNMATCHED_ROUTE_LABEL && route !== "/metrics") {
      const userId = ctx?.requestContext?.userId;
      void deps.usageMeter.record({
        userId,
        eventType: "api.call",
        resourceId: route,
        quantity: 1,
        metadata: { method, status_code: statusCode },
      });
    }
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
      const rawUrl = req.url?.split("?")[0] ?? "";

      // P0-1 — Normalize `/api/v1/*` (canonical) and legacy `/api/admin/*` /
      // `/api/gateway/*` to the same internal path the routers were registered
      // with (`/api/admin/*` / `/api/gateway/*`). Legacy callers still work but
      // get Deprecation + Sunset headers on every response so SDKs can surface
      // the migration warning without a breaking change.
      let url = rawUrl;
      let isLegacyAlias = false;
      let canonicalRedirect: string | null = null;
      if (rawUrl.startsWith("/api/v1/")) {
        url = "/api/" + rawUrl.slice("/api/v1/".length);
      } else if (rawUrl.startsWith("/api/admin/") || rawUrl.startsWith("/api/gateway/")) {
        isLegacyAlias = true;
        canonicalRedirect = "/api/v1/" + rawUrl.slice("/api/".length);
      } else if (rawUrl === "/api/health") {
        // Allow legacy `/api/health` to also emit deprecation pointing at v1.
        isLegacyAlias = true;
        canonicalRedirect = "/api/v1/livez";
      }
      if (isLegacyAlias && canonicalRedirect) {
        emitDeprecationHeaders(res, canonicalRedirect);
      }

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
            jwtSecret: deps.jwtSecret,
            jwtIssuer: deps.jwtIssuer,
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

      // P0-7 — k8s probes: liveness ("am I alive?") vs readiness ("should I
      // receive traffic?"). `/api/health` is a back-compat alias for liveness.
      if (url === "/api/health" || url === "/api/livez") {
        json(res, 200, checkLiveness());
        recordMetrics(url === "/api/livez" ? "/api/livez" : "/api/health", req.method!, 200, startTime);
        return;
      }
      if (url === "/api/readyz") {
        const probe = await checkReadiness({ skillRepo: deps.skillRepo });
        const code = probe.status === "ok" ? 200 : 503;
        json(res, code, probe);
        recordMetrics("/api/readyz", req.method!, code, startTime);
        return;
      }

      // P0-2 — OpenAPI spec + Swagger UI. Anonymous (no auth) so SDK generators
      // and developers can introspect the API without a token. The canonical
      // URLs use the `/api/v1/` prefix; legacy `/api/openapi.json` and
      // `/api/docs` resolve here (after the v1 → unprefixed normalization
      // above) and get the same Deprecation/Sunset headers as other legacy
      // aliases. The spec doc itself lists `/api/v1` as the primary server.
      if (url === "/api/openapi.json") {
        const spec = getOpenApiSpec();
        res.setHeader("Cache-Control", "public, max-age=300");
        json(res, 200, spec);
        recordMetrics("/api/openapi.json", req.method!, 200, startTime);
        return;
      }
      if (url === "/api/docs" || url === "/api/docs/") {
        const html = renderSwaggerUiHtml("/api/v1/openapi.json");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        recordMetrics("/api/docs", req.method!, 200, startTime);
        return;
      }

      // Auth routes — no admin auth required (login/refresh/change-password).
      if (url.startsWith("/api/auth/")) {
        if (deps.authRouter) {
          const match = deps.authRouter.match(req.method!, url);
          if (match) {
            const ctx: HttpContext = { req, res, url, method: req.method!, params: match.params, query: parseQuery(req.url ?? "/", req.headers.host), logger };
            await deps.authRouter.dispatch(ctx);
            recordMetrics(url, req.method!, res.statusCode, startTime, ctx);
            return;
          }
        }
      }

      // Gateway routes — token enforced by enforceGatewayAuth middleware before dispatch.
      // /api/gateway/health is the only anonymous-accessible endpoint (LB / k8s probes).
      if (url.startsWith("/api/gateway/")) {
        const match = gatewayRouter.match(req.method!, url);
        if (match) {
          const ctx: HttpContext = { req, res, url, method: req.method!, params: match.params, query: parseQuery(req.url ?? "/", req.headers.host), logger };
          if (url !== "/api/gateway/health") {
            const requestContext = await enforceGatewayAuth(ctx, {
              userRepo: deps.userRepo,
              userRoleRepo: deps.userRoleRepo,
              jwtSecret: deps.jwtSecret,
              jwtIssuer: deps.jwtIssuer,
            });
            if (!requestContext) {
              recordMetrics(url, req.method!, res.statusCode, startTime, ctx);
              return;
            }
            ctx.requestContext = requestContext;
          }
          await gatewayRouter.dispatch(ctx);
          recordMetrics(url, req.method!, res.statusCode, startTime, ctx);
          return;
        }
      }

      // Admin routes — enforce userType-gated bearer auth before dispatch.
      if (url.startsWith("/api/admin/")) {
        const match = adminRouter.match(req.method!, url);
        if (match) {
          const ctx: HttpContext = { req, res, url, method: req.method!, params: match.params, query: parseQuery(req.url ?? "/", req.headers.host), logger };
          const requestContext = await enforceAdminAuth(ctx, {
            userRepo: deps.userRepo,
            userRoleRepo: deps.userRoleRepo,
            jwtSecret: deps.jwtSecret,
            jwtIssuer: deps.jwtIssuer,
          });
          if (!requestContext) {
            recordMetrics(url, req.method!, res.statusCode, startTime, ctx);
            return;
          }
          ctx.requestContext = requestContext;
          await adminRouter.dispatch(ctx);
          recordMetrics(url, req.method!, res.statusCode, startTime, ctx);
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
