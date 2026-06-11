// P0-2 — Hand-authored OpenAPI 3.1 document for the public HTTP surface.
//
// Why hand-authored? The review (§5.2) recommends `zod-to-openapi` from the
// handler zod schemas, but the current handlers parse bodies with ad-hoc
// `readJsonBody<T>()` and have no zod schemas to derive from. A full handler
// rewrite is well beyond the P0-2 budget (3d). Hand-authoring delivers the
// user-facing artifact today; future work can drop in zod-to-openapi without
// changing the served URL contract (`/api/v1/openapi.json`, `/api/v1/docs`).
//
// Versioning rule: `info.version` tracks package.json version, NOT the API
// version. The API version is encoded in the `/api/v1/` URL prefix.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function readPackageVersion(): string {
  try {
    // dist/http/openapi/spec.js → ../../../package.json
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string; description: string }[];
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
  security: { bearerAuth: string[] }[];
  paths: Record<string, Record<string, unknown>>;
  tags: { name: string; description: string }[];
}

export function buildOpenApiSpec(): OpenApiDoc {
  return {
    openapi: "3.1.0",
    info: {
      title: "Skill MCP HTTP API",
      version: readPackageVersion(),
      description:
        "REST surface of the Skill MCP server. Admin endpoints manage skills, users, roles, and import jobs; gateway endpoints serve authenticated clients. " +
        "MCP tools (`skill_list`, `skill_view`, `skill_file`) are exposed via the MCP transport at `/mcp` and `/mcp/sse` and are NOT documented here. " +
        "All responses use `application/json` unless noted. Authentication is via `Authorization: Bearer <token>` (issued by `skill-mcp user create`). " +
        "Error contract: every non-2xx response has shape `{ success: false, error: { code, message, ...details } }`. " +
        "Codes are stable identifiers safe for programmatic branching; messages are human-readable and may be localized in future releases.",
    },
    servers: [
      { url: "/api/v1", description: "Canonical (current)" },
      { url: "/api", description: "Legacy alias (deprecated; Sunset 2026-11-28)" },
    ],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Health", description: "Liveness and readiness probes" },
      { name: "Admin / Skills", description: "Skill CRUD, import, lifecycle" },
      { name: "Admin / Jobs", description: "Async import jobs (P0-10)" },
      { name: "Admin / Users", description: "User and bearer-token management (P0-4 token rotation)" },
      { name: "Admin / Roles", description: "Roles and tag bindings (RBAC)" },
      { name: "Gateway / Skills", description: "Authenticated client-facing skill access" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Per-user bearer token issued by `skill-mcp user create` or rotated via `POST /admin/users/{id}/tokens/rotate`. " +
            "Anonymous calls are rejected at gateway/admin paths (except `/gateway/health`).",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["success", "error"],
          properties: {
            success: { type: "boolean", enum: [false] },
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", description: "Stable error identifier (do NOT translate)", example: "SKILL_NOT_FOUND" },
                message: { type: "string", description: "Human-readable, may be localized" },
              },
              additionalProperties: true,
            },
          },
        },
        SkillStatus: { type: "string", enum: ["draft", "published", "deprecated", "archived"] },
        Visibility: { type: "string", enum: ["public", "internal", "private"] },
        SkillMeta: {
          type: "object",
          required: ["id", "slug", "name", "version", "status", "visibility", "tags", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string", format: "uuid" },
            slug: { type: "string", example: "prompt-writer" },
            name: { type: "string" },
            displayName: { type: "string", nullable: true },
            description: { type: "string", nullable: true },
            version: { type: "string", example: "1.2.3" },
            category: { type: "string", nullable: true },
            tags: { type: "array", items: { type: "string" } },
            status: { $ref: "#/components/schemas/SkillStatus" },
            visibility: { $ref: "#/components/schemas/Visibility" },
            createdAt: { type: "integer", format: "int64" },
            updatedAt: { type: "integer", format: "int64" },
          },
        },
        ImportJobStatus: { type: "string", enum: ["queued", "running", "succeeded", "failed"] },
        ImportJobView: {
          type: "object",
          description: "Note: `options` (source/branch/token) is intentionally omitted from poll responses to avoid leaking secrets.",
          required: ["id", "status", "progress", "source", "created_at"],
          properties: {
            id: { type: "string" },
            status: { $ref: "#/components/schemas/ImportJobStatus" },
            progress: { type: "integer", minimum: 0, maximum: 100 },
            message: { type: "string", nullable: true },
            source: { type: "string" },
            result: { type: "object", nullable: true },
            error: { type: "string", nullable: true },
            created_by_user_id: { type: "string", nullable: true },
            created_at: { type: "integer", format: "int64" },
            started_at: { type: "integer", format: "int64", nullable: true },
            finished_at: { type: "integer", format: "int64", nullable: true },
          },
        },
        UserPublic: {
          type: "object",
          required: ["id", "username", "createdAt"],
          properties: {
            id: { type: "string" },
            username: { type: "string" },
            email: { type: "string", nullable: true },
            tags: { type: "array", items: { type: "string" } },
            createdAt: { type: "integer", format: "int64" },
            tokenExpiresAt: { type: "integer", format: "int64", nullable: true },
          },
        },
        Role: {
          type: "object",
          required: ["id", "name", "tags"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string", nullable: true },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    paths: {
      "/health": {
        get: {
          tags: ["Health"],
          security: [],
          summary: "Server liveness probe (back-compat alias for /livez)",
          responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" }, timestamp: { type: "string" } } } } } } },
        },
      },
      "/livez": {
        get: {
          tags: ["Health"],
          security: [],
          summary: "Kubernetes liveness probe — process is alive",
          description: "Always returns 200 if the event loop is responsive. Maps to k8s `livenessProbe`. Failure of this probe causes the kubelet to restart the pod.",
          responses: { "200": { description: "Alive", content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", example: "ok" }, timestamp: { type: "string" } } } } } } },
        },
      },
      "/readyz": {
        get: {
          tags: ["Health"],
          security: [],
          summary: "Kubernetes readiness probe — accepting traffic",
          description: "Returns 200 only when dependencies (DB) are reachable; 503 otherwise. Maps to k8s `readinessProbe`. Failure of this probe removes the pod from Service endpoints (no restart).",
          responses: {
            "200": { description: "Ready", content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", example: "ok" }, checks: { type: "object" } } } } } },
            "503": { description: "Not ready (dependency check failed)", content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", example: "not_ready" }, checks: { type: "object" } } } } } },
          },
        },
      },
      "/gateway/health": {
        get: {
          tags: ["Health"],
          security: [],
          summary: "Gateway liveness (anonymous; LB/k8s probe)",
          responses: { "200": { description: "OK" } },
        },
      },
      "/admin/skills": {
        get: {
          tags: ["Admin / Skills"],
          summary: "List skills (admin view; includes draft/archived)",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "status", in: "query", schema: { $ref: "#/components/schemas/SkillStatus" } },
            { name: "visibility", in: "query", schema: { $ref: "#/components/schemas/Visibility" } },
          ],
          responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "array", items: { $ref: "#/components/schemas/SkillMeta" } }, total: { type: "integer" } } } } } } },
        },
      },
      "/admin/skills/{slug}": {
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        get: { tags: ["Admin / Skills"], summary: "Fetch a skill", responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/SkillMeta" } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
        put: { tags: ["Admin / Skills"], summary: "Update mutable fields", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { displayName: { type: "string" }, description: { type: "string" }, category: { type: "string" }, tags: { type: "array", items: { type: "string" } }, visibility: { $ref: "#/components/schemas/Visibility" } } } } } }, responses: { "200": { description: "OK" }, "404": { $ref: "#/components/responses/NotFound" } } },
        delete: { tags: ["Admin / Skills"], summary: "Delete a skill (hard delete)", responses: { "204": { description: "Deleted" }, "404": { $ref: "#/components/responses/NotFound" } } },
      },
      "/admin/skills/{slug}/publish": { post: { tags: ["Admin / Skills"], summary: "Lifecycle: publish (P0-9)", parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Transitioned", content: { "application/json": { schema: { $ref: "#/components/schemas/SkillMeta" } } } }, "409": { description: "Illegal lifecycle transition", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
      "/admin/skills/{slug}/deprecate": { post: { tags: ["Admin / Skills"], summary: "Lifecycle: deprecate (P0-9)", parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Transitioned" }, "409": { description: "Illegal lifecycle transition" } } } },
      "/admin/skills/{slug}/archive": { post: { tags: ["Admin / Skills"], summary: "Lifecycle: archive (terminal)", parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Transitioned" }, "409": { description: "Illegal lifecycle transition" } } } },
      "/admin/skills/{slug}/republish": { post: { tags: ["Admin / Skills"], summary: "Lifecycle: republish from deprecated", parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Transitioned" }, "409": { description: "Illegal lifecycle transition" } } } },
      "/admin/skills/{slug}/lifecycle/next": { get: { tags: ["Admin / Skills"], summary: "Get the set of legal next states", parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { current: { $ref: "#/components/schemas/SkillStatus" }, next: { type: "array", items: { $ref: "#/components/schemas/SkillStatus" } } } } } } } } } },

      "/admin/skills/import/async": {
        post: {
          tags: ["Admin / Jobs"],
          summary: "Enqueue async import job (P0-10)",
          description: "Accepts a JSON body with `source` (local path or git URL). Returns 202 with a job id; poll `/admin/jobs/{jobId}` for terminal state.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["source"], properties: { source: { type: "string" }, category: { type: "string" }, tags: { type: "array", items: { type: "string" } }, description: { type: "string" }, target_id: { type: "string" }, version_bump: { type: "string", enum: ["major", "minor", "patch"], default: "patch" }, overwrite: { type: "boolean", default: false }, allow_duplicate: { type: "boolean", default: false }, slug: { type: "string" }, branch: { type: "string" }, sub_dir: { type: "string" } } } } } },
          responses: {
            "202": { description: "Accepted", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "object", properties: { job_id: { type: "string" }, status: { $ref: "#/components/schemas/ImportJobStatus" }, poll_url: { type: "string" } } } } } } } },
            "400": { description: "Missing source or unsupported content type", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/admin/jobs": {
        get: {
          tags: ["Admin / Jobs"],
          summary: "List import jobs",
          parameters: [
            { name: "status", in: "query", schema: { $ref: "#/components/schemas/ImportJobStatus" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          ],
          responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "array", items: { $ref: "#/components/schemas/ImportJobView" } }, total: { type: "integer" } } } } } } },
        },
      },
      "/admin/jobs/{jobId}": { get: { tags: ["Admin / Jobs"], summary: "Get job status", parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/ImportJobView" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } } },
      "/admin/jobs/{jobId}/progress": { get: { tags: ["Admin / Jobs"], summary: "Lightweight progress projection", parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" }, "404": { $ref: "#/components/responses/NotFound" } } } },

      "/admin/users": {
        get: { tags: ["Admin / Users"], summary: "List users", responses: { "200": { description: "OK" } } },
        post: { tags: ["Admin / Users"], summary: "Create user (returns one-time token)", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["username"], properties: { username: { type: "string" }, email: { type: "string" }, role_ids: { type: "array", items: { type: "string" } }, token_ttl_days: { type: "integer", description: "P0-4 token TTL in days; omit/0 = non-expiring" } } } } } }, responses: { "201": { description: "Created", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "object", properties: { user: { $ref: "#/components/schemas/UserPublic" }, token: { type: "string", description: "One-time secret; not retrievable later" } } } } } } } } } },
      },
      "/admin/users/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { tags: ["Admin / Users"], summary: "Get user", responses: { "200": { description: "OK" }, "404": { $ref: "#/components/responses/NotFound" } } },
        delete: { tags: ["Admin / Users"], summary: "Delete user", responses: { "204": { description: "Deleted" }, "404": { $ref: "#/components/responses/NotFound" } } },
      },
      "/admin/users/{id}/tokens/rotate": {
        post: {
          tags: ["Admin / Users"],
          summary: "Rotate bearer token (P0-4 dual-token grace)",
          description: "Issues a new token and keeps the previous one valid for the configured grace period. Both tokens authenticate during the overlap window, after which only the new token is accepted.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { grace_seconds: { type: "integer", description: "Override default grace window" }, token_ttl_days: { type: "integer" } } } } } },
          responses: { "200": { description: "Rotated", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "object", properties: { token: { type: "string" }, expires_at: { type: "integer", nullable: true }, previous_token_expires_at: { type: "integer" } } } } } } } } },
        },
      },

      "/admin/roles": {
        get: { tags: ["Admin / Roles"], summary: "List roles", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "array", items: { $ref: "#/components/schemas/Role" } } } } } } } } },
        post: { tags: ["Admin / Roles"], summary: "Create role", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, description: { type: "string" }, tags: { type: "array", items: { type: "string" } } } } } } }, responses: { "201": { description: "Created" } } },
      },
      "/admin/roles/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        delete: { tags: ["Admin / Roles"], summary: "Delete role", responses: { "204": { description: "Deleted" } } },
      },

      "/gateway/skills": {
        get: { tags: ["Gateway / Skills"], summary: "List visible skills (filtered by caller tags)", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "array", items: { $ref: "#/components/schemas/SkillMeta" } } } } } } } } },
      },
      "/gateway/skills/{slug}": {
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        get: { tags: ["Gateway / Skills"], summary: "Get skill metadata + entry content", responses: { "200": { description: "OK" }, "403": { description: "Visibility denied" }, "404": { $ref: "#/components/responses/NotFound" } } },
      },
    },
  };
}

// `components.responses` is patched in here so the inline `$ref:
// "#/components/responses/NotFound"` shorthands above resolve.
export function getOpenApiSpec(): OpenApiDoc {
  const doc = buildOpenApiSpec();
  (doc.components as unknown as { responses: Record<string, unknown> }).responses = {
    NotFound: {
      description: "Not found",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    },
  };
  return doc;
}
