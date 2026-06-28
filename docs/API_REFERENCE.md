# MCP Tools API Reference

This document provides a complete reference for the three MCP tools exposed by skill-mcp: `skill_list`, `skill_view`, and `skill_file`. These tools implement the model compliance architecture described in [tech-dev-program.md](./tech-dev-program.md) Section 3.

---

## API Versioning

The canonical path prefix is `/api/v1/*`. All unversioned paths (`/api/admin/*`, `/api/gateway/*`, `/api/auth/*`) remain functional aliases during a 6-month deprecation window (scheduled removal after **2026-11-28**). Clients SHOULD migrate to the `/api/v1/` prefix. Legacy responses include `Sunset` and `Deprecation` headers per RFC 8594.

---

## 1. skill_list

**Purpose**: Retrieve the complete list of available skills in the system.

This is the entry point for skill discovery. The model must scan this list on every response to identify potentially relevant skills.

### Parameters

None

### Response Format

Plain text list, one skill per line:

```
- slug-1 [id:uuid-1]: Brief one-line description (max 80 chars)
- slug-2 [id:uuid-2]: Another skill description
- slug-3 [id:uuid-3]: Yet another skill
```

### Example

**Request** (MCP JSON-RPC):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "skill_list",
    "arguments": {}
  }
}
```

**Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "- prompt-writer [id:550e8400-e29b-41d4-a716-446655440000]: Professional prompt writing and optimization\n- code-review [id:550e8400-e29b-41d4-a716-446655440001]: Code review and debugging assistance\n- technical-doc [id:550e8400-e29b-41d4-a716-446655440002]: Technical documentation writing"
      }
    ]
  }
}
```

### Compliance Requirements

- **Must be called frequently**: The model should scan this list before every response
- **Must include slug and id**: Each skill entry includes both `slug` (for stable reference) and `id` (UUID for internal lookup)
- **Description quality matters**: Brief, action-oriented descriptions help with semantic matching
- **Mandatory keyword**: System prompt includes "mandatory" to enforce scanning

### Implementation Notes

- `slug` format: kebab-case, URL-safe, unique
- `id` format: UUID v4
- Description: Truncated to 80 characters if longer
- Only includes `status: "published"` skills
- Results are cached (TTL: typically 5-10 minutes)

---

## 2. skill_view

**Purpose**: Load the complete skill instructions (SKILL.md) for a specific skill.

This is the primary interface for skill execution. The model must call this tool FIRST before attempting to use any skill.

### Parameters

Either `skill_slug` OR `skill_id` (exactly one):

| Parameter | Type | Required | Format | Notes |
|-----------|------|----------|--------|-------|
| `skill_slug` | string | Yes (unless id provided) | kebab-case | Preferred for stable references |
| `skill_id` | string | Yes (unless slug provided) | UUID v4 | From skill_list response |

### Response Format

Multi-part response combining:
1. **System guidance** (activated on tool call)
2. **Complete skill instructions** (SKILL.md content)
3. **File listing** (available supporting files)

### Example

**Request** (by slug):
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "skill_view",
    "arguments": {
      "skill_slug": "prompt-writer"
    }
  }
}
```

**Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "[SYSTEM: User is using \"prompt-writer\" skill. Below is complete instruction, follow strictly.]\n\n# Prompt Writer\n\n## Trigger Conditions\nWhen user asks to: create prompt / optimize prompt / evaluate prompt\n\n## Execution Steps (MUST follow strictly)\n1. Use CRISPE framework (see references/crispe-framework.md)\n2. Draft prompt following framework structure\n3. Self-check using templates/checklist.md\n\n## Known Pitfalls\n- Do NOT start with \"you are\"\n- Do NOT over-constrain\n\n[Available supporting files: references/crispe-framework.md, templates/checklist.md]\n[Tip: Use skill_file(\"prompt-writer\", [\"references/crispe-framework.md\", \"templates/checklist.md\"]) to batch-load files]"
      }
    ]
  }
}
```

### Alternative (by id):
```json
{
  "arguments": {
    "skill_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

### Compliance Requirements

- **Activation guidance injection**: Response includes `[SYSTEM: ...]` prefix to reinforce instruction adherence
- **Security scanning**: SKILL.md content is scanned for injection patterns before returning
- **File tree listing**: Supporting files are enumerated to guide the model's `skill_file` calls
- **Strict instruction format**: All SKILL.md files must include:
  - Trigger Conditions
  - Execution Steps (numbered, in order)
  - Known Pitfalls (do/don't rules)

### Implementation Notes

- Response is wrapped with activation guidance (system message format)
- File tree includes only files actually in the package
- Security scan uses pattern matching for common injection attempts
- Cached (TTL: typically 10-30 minutes)

---

## 3. skill_file

**Purpose**: Batch-load supporting files from a skill package (references, templates, scripts).

This tool MUST be called with multiple file paths when the skill_view instructions reference them. It supports concurrent file loading.

### Parameters

| Parameter | Type | Required | Format | Notes |
|-----------|------|----------|--------|-------|
| `skill_slug` | string | Yes | kebab-case | From skill_list or skill_view |
| `file_paths` | string[] | Yes | Array of paths | E.g., `["references/framework.md", "templates/checklist.md"]` |

### Response Format

Array of `SkillFileContent` objects, one per requested file:

```typescript
[
  {
    path: "references/framework.md",
    content: "# File content...",
    encoding: "utf-8"        // text files (.md, .txt, .json, etc.)
  },
  {
    path: "assets/icon.png",
    content: "iVBORw0KGgoAAAANS...",
    encoding: "base64",       // binary files (.png, .jpg, .gif, etc.)
    mimeType: "image/png"     // optional, present for binary files
  }
]
```

### Example

**Request** (batch multiple files):
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "skill_file",
    "arguments": {
      "skill_slug": "prompt-writer",
      "file_paths": [
        "references/crispe-framework.md",
        "references/create-framework.md",
        "templates/checklist.md"
      ]
    }
  }
}
```

**Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "path": "references/crispe-framework.md",
        "content": "# CRISPE Framework\n\n**C** = Clarity\n**R** = Role\n...",
        "encoding": "utf-8"
      },
      {
        "path": "references/create-framework.md",
        "content": "# CREATE Framework\n\n**C** = Context\n**R** = Role\n...",
        "encoding": "utf-8"
      },
      {
        "path": "templates/checklist.md",
        "content": "# Self-Check Checklist\n\n- [ ] Clarity\n- [ ] Role\n...",
        "encoding": "utf-8"
      }
    ]
  }
}
```

### Compliance Requirements

- **Batch loading**: Pass multiple paths in ONE call (not separate calls)
- **Only referenced files**: Load only files explicitly mentioned in skill_view instructions
- **File path validation**: Paths must be relative and cannot contain `..` or `/` traversal patterns
- **Permission-based access**: User must have permission to access the skill before file loading
- **Security scan**: Files are scanned for injection patterns

### Optimization

- Concurrent loading: All paths loaded in parallel (Promise.all)
- Text file caching: .md, .txt, .json files cached (TTL: 5-10 minutes)
- Binary file streaming: .png, .jpg, .gif, .mp4 etc. returned as base64
- Cache hit performance: Repeated file access returns cached results

### Implementation Notes

- File list is pre-validated against manifest.json files list
- Non-existent files return error 404
- Oversized files (>10MB) may be rejected or streamed
- Base64 encoding adds ~33% size overhead (plan accordingly)

---

## 4. Auth API Endpoints

Authentication endpoints for obtaining and managing JWT access tokens.

### POST /api/auth/login

Authenticate a user and receive access + refresh tokens.

**Request**:
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "secret"}'
```

**Response**:
```json
{
  "success": true,
  "data": {
    "access_token": "eyJhbGciOi...",
    "refresh_token": "eyJhbGciOi...",
    "token_type": "Bearer",
    "expires_in": 7200
  }
}
```

### POST /api/auth/refresh

Refresh an expired access token using a valid refresh token.

**Request**:
```bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refresh_token": "eyJhbGciOi..."}'
```

### POST /api/auth/change-password

Change the authenticated user's password. Requires a valid Bearer token.

**Request**:
```bash
curl -X POST http://localhost:3000/api/auth/change-password \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"current_password": "old", "new_password": "new"}'
```

---

## 5. Admin API Endpoints

All admin endpoints require **JWT Bearer Token** authentication with `userType` of `admin` or `superadmin`. The `enforceAdminAuth()` middleware validates the JWT, checks token expiry, and verifies the user has admin-level privileges. Requests without a valid token or with insufficient privileges are rejected with 401/403.

```bash
Authorization: Bearer <jwt_access_token>
```

### 5.1 Skills Management

#### GET /api/admin/skills

List all available skills with pagination and filtering.

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `offset` | number | Pagination offset (default: 0) |
| `limit` | number | Page size (default: 50) |
| `category` | string | Filter by category |
| `tags` | string | Comma-separated tag list (AND match) |
| `attributes.*` | string | Filter by dynamic attribute, e.g. `attributes.framework=react` |

**Request**:
```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/api/admin/skills?offset=0&limit=50&category=writing&tags=prompt,ai"
```

**Response**:
```json
{
  "success": true,
  "data": [
    { "id": "...", "slug": "prompt-writer", "name": "prompt-writer", "version": "0.0.1" }
  ],
  "total": 1,
  "offset": 0,
  "limit": 50
}
```

#### GET /api/admin/skills/{slug}

Get a specific skill by slug.

**Response**:
```json
{
  "success": true,
  "data": { "id": "...", "slug": "prompt-writer", "name": "...", "description": "..." }
}
```

#### PUT /api/admin/skills/{slug}

Update skill metadata.

**Request**:
```bash
curl -X PUT http://localhost:3000/api/admin/skills/prompt-writer \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"category": "writing", "tags": ["prompt", "ai"]}'
```

#### DELETE /api/admin/skills/{slug}

Delete a skill and its files.

#### POST /api/admin/skills

Import a new skill from a source path.

**Request Body**:

| Field | Type | Description |
|-------|------|-------------|
| `source` | string | **Required.** Path or URL to the skill source |
| `category` | string | Skill category |
| `tags` | string[] | List of tags |
| `description` | string | Skill description |
| `target_id` | string | Existing skill ID to overwrite (use with `overwrite: true`) |
| `version_bump` | `"major" \| "minor" \| "patch"` | Version increment strategy (default: `"patch"`) |
| `overwrite` | boolean | Whether to overwrite an existing skill (default: `false`) |
| `allow_duplicate` | boolean | Allow importing a skill with a duplicate name (default: `false`) |
| `slug` | string | Custom slug override |
| `branch` | string | Git branch (when source is a git repo) |
| `sub_dir` | string | Subdirectory within the source (for monorepos) |

**Request**:
```bash
curl -X POST http://localhost:3000/api/admin/skills \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"source": "/path/to/skill", "category": "writing", "tags": ["prompt"], "version_bump": "minor"}'
```

#### GET /api/admin/skills/{slug}/entry

Get the entry file (SKILL.md) content.

**Response**: Raw markdown content (`Content-Type: text/markdown; charset=utf-8`)

#### POST /api/admin/skills/{slug}/files

Batch-read multiple skill files.

**Request**:
```bash
curl -X POST http://localhost:3000/api/admin/skills/prompt-writer/files \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"paths": ["references/crispe-framework.md", "templates/checklist.md"]}'
```

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "path": "references/crispe-framework.md",
      "content": "# CRISPE Framework\n\n...",
      "encoding": "utf-8"
    },
    {
      "path": "templates/checklist.md",
      "content": "# Self-Check Checklist\n\n...",
      "encoding": "utf-8"
    }
  ]
}
```

**Response Object Fields** (`SkillFileContent`):

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | File path relative to skill root |
| `content` | string | File content (raw UTF-8 or base64-encoded) |
| `encoding` | `"utf-8" \| "base64"` | Content encoding |
| `mimeType` | string? | MIME type (present for binary files) |

#### GET /api/admin/skills/{slug}/file-tree

Get the file tree structure of a skill.

#### GET /api/admin/skills/name/{name}

Search skills by name.

#### GET /api/admin/skills/{slug}/versions

Get version history for a skill.

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | number | Max versions to return (default: 10) |

#### GET /api/admin/skills/{slug}/versions/diff

Compare two skill versions.

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `v1` | string | First version |
| `v2` | string | Second version |

#### GET /api/admin/skills/{slug}/lifecycle/next

Get valid next lifecycle states for a skill.

#### POST /api/admin/skills/{slug}/publish

Transition a skill to `published` status.

#### POST /api/admin/skills/{slug}/deprecate

Transition a skill to `deprecated` status.

#### POST /api/admin/skills/{slug}/archive

Transition a skill to `archived` status.

#### POST /api/admin/skills/{slug}/republish

Transition a skill back to `published` status.

#### POST /api/admin/skills/{slug}/rollback

Rollback a skill to a previous version.

**Request Body**:

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | **Required.** Target version to rollback to |
| `bump` | `"major" \| "minor" \| "patch"` | Version bump strategy for the new version |

#### PUT /api/admin/skills/{slug}/retrieval

Update retrieval metadata (embedding hints, keyword weights, etc.). Send `null` to clear all retrieval fields.

#### POST /api/admin/skills/upload

Upload a skill package via multipart/form-data.

#### GET /api/admin/skills/effectiveness-report

Get skill effectiveness rates over a time window.

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `days` | number | Lookback window in days (default: 30) |

#### GET /api/admin/skills/{slug}/eval/cases

Get eval cases for a skill (parsed from SKILL.md frontmatter).

#### POST /api/admin/skills/{slug}/eval/run

Run eval cases against a skill. Requires an eval runner to be configured.

#### GET /api/admin/skills/{slug}/eval/results

Get eval results for a skill.

### 5.2 Users Management

#### GET /api/admin/users

List all users.

**Response**:
```json
{
  "success": true,
  "data": [
    { "id": "...", "username": "admin", "userType": "admin", "status": "active" }
  ]
}
```

#### POST /api/admin/users

Create a new user.

**Request Body**:

| Field | Type | Description |
|-------|------|-------------|
| `username` | string | **Required.** Username |
| `password` | string | User password |
| `userType` | string | User type (`admin`, `superadmin`, `user`) |
| `token_expires_at` | number? | Custom token expiry timestamp (ms) |
| `expires_in` | number? | Token TTL in seconds |

**Note**: Creating `superadmin` users requires a `superadmin` caller. `admin` targets can only be created by `superadmin`.

#### GET /api/admin/users/{userId}

Get a specific user by ID.

#### PUT /api/admin/users/{userId}

Update a user. `superadmin` targets are protected — only the superadmin can operate on themselves.

#### DELETE /api/admin/users/{userId}

Delete a user. `superadmin` targets cannot be deleted. `admin` targets require a `superadmin` caller.

#### POST /api/admin/users/{userId}/rotate-token

Rotate the API token for a user. Returns the new token (shown once).

#### DELETE /api/admin/users/{userId}/previous-token

Revoke the previous token during the grace period after rotation.

#### PUT /api/admin/users/{userId}/roles

Assign roles to a user.

**Request Body**:
```json
{ "roleIds": ["role-id-1", "role-id-2"] }
```

#### POST /api/admin/users/{username}/reset-password

Reset a user's password. Admin can only reset own password; superadmin can reset any admin.

### 5.3 Roles Management

Built-in roles (`superadmin`, `admin`, `user`) cannot be created, modified, or deleted.

#### GET /api/admin/roles

List all roles.

#### POST /api/admin/roles

Create a new custom role.

**Request Body**:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | **Required.** Role name (must not be a built-in name) |
| `description` | string? | Role description |
| `tags` | string[] | **Required.** Permission tags assigned to this role |

#### GET /api/admin/roles/{roleId}

Get a specific role by ID.

#### PUT /api/admin/roles/{roleId}

Update a custom role. Cannot modify built-in roles.

**Request Body**:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string? | New role name |
| `description` | string? | New description |
| `tags` | string[]? | Updated permission tags |

#### DELETE /api/admin/roles/{roleId}

Delete a custom role. Cannot delete built-in roles. Users assigned to this role will have their skill list cache invalidated.

### 5.4 Quotas & Tier Limits

#### GET /api/admin/tenants/{tenantId}/quota

Get the current quota row for a tenant. Auto-seeds a `free` tier on first read.

#### PUT /api/admin/tenants/{tenantId}/quota

Change the tier or individual quota limits.

**Request Body**:

| Field | Type | Description |
|-------|------|-------------|
| `tier` | `"free" \| "team" \| "enterprise"` | Set tier (resets limits to tier defaults) |
| `maxSkills` | number? | Max number of skills |
| `maxStorageBytes` | number? | Max storage in bytes |
| `maxApiCallsPerHour` | number? | Max API calls per hour |
| `maxWebhooks` | number? | Max webhook subscriptions |
| `maxFileSizeBytes` | number? | Max single file size |
| `maxConcurrentImports` | number? | Max concurrent import jobs |

#### GET /api/admin/tenants/{tenantId}/quota/history

Get chronological quota change history (newest first).

#### GET /api/admin/tenants/{tenantId}/overrides

Get active quota overrides (or all with `?all=true`).

#### POST /api/admin/tenants/{tenantId}/overrides

Create a quota override. Requires an audit-grade reason.

**Request Body**:

| Field | Type | Description |
|-------|------|-------------|
| `field` | string | **Required.** Quota field to override |
| `value` | number | **Required.** Override value |
| `reason` | string | **Required.** Audit reason |
| `expiresAt` | number? | Expiry timestamp (ms) |

#### DELETE /api/admin/quota-overrides/{overrideId}

Remove a single quota override.

### 5.5 Webhooks

#### GET /api/admin/webhooks

List all webhook subscriptions (secrets are hidden).

#### POST /api/admin/webhooks

Create a new webhook subscription. The secret is returned **once** in this response.

**Request Body**:

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | **Required.** Webhook delivery URL |
| `event_types` | string[] | **Required.** Event types to subscribe to |
| `enabled` | boolean? | Enable/disable (default: `true`) |
| `description` | string? | Human-readable description |

#### GET /api/admin/webhooks/{id}

Get a webhook subscription detail (secret is hidden).

#### PUT /api/admin/webhooks/{id}

Update a webhook subscription.

**Request Body**:

| Field | Type | Description |
|-------|------|-------------|
| `url` | string? | Delivery URL |
| `event_types` | string[]? | Subscribed event types |
| `enabled` | boolean? | Enable/disable |
| `description` | string? | Description |

#### POST /api/admin/webhooks/{id}/rotate

Rotate the webhook secret. The new secret is returned **once**.

#### DELETE /api/admin/webhooks/{id}

Delete a webhook subscription (cascade-deletes orphan deliveries).

#### GET /api/admin/webhooks/{id}/deliveries

Get the last N deliveries for audit.

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | number | Max deliveries to return (default: 50) |

#### POST /api/admin/webhook-deliveries/{id}/replay

Re-queue a dead-lettered delivery.

### 5.6 Usage Metering

#### GET /api/admin/usage/aggregate

Get aggregated usage data.

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `tenantId` | string | Filter by tenant (default: `"default"`) |
| `fromBucket` | string | Start bucket (`YYYY-MM-DDTHH` format) |
| `toBucket` | string | End bucket (`YYYY-MM-DDTHH` format) |
| `eventType` | string | Filter by event type (e.g. `skill.view`, `pipeline.run`, `api.call`, `storage.write`) |
| `format` | `"json" \| "csv"` | Response format (default: `"json"`) |

#### GET /api/admin/usage/events

List raw usage events.

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `tenantId` | string | Filter by tenant |
| `fromBucket` | string | Start bucket (`YYYY-MM-DDTHH` format) |
| `toBucket` | string | End bucket (`YYYY-MM-DDTHH` format) |
| `eventType` | string | Filter by event type |
| `limit` | number | Max events (default: 100, max: 10000) |

### 5.7 Import Jobs

#### POST /api/admin/skills/import/async

Enqueue an async skill import job.

**Request Body**:

| Field | Type | Description |
|-------|------|-------------|
| `source` | string | **Required.** Skill source path or URL |
| `category` | string? | Skill category |
| `tags` | string[]? | Tags |
| `slug` | string? | Custom slug |
| `branch` | string? | Git branch |
| `sub_dir` | string? | Subdirectory |

#### GET /api/admin/jobs

List import jobs.

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by status |
| `limit` | number | Max jobs to return |

#### GET /api/admin/jobs/{jobId}

Get a specific import job.

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "...",
    "status": "completed",
    "progress": 100,
    "message": "Imported 3 files",
    "source": "/path/to/skill",
    "result": { "slug": "my-skill", "version": "0.0.1" },
    "error": null,
    "created_by_user_id": "...",
    "created_at": "2026-01-01T00:00:00.000Z",
    "started_at": "2026-01-01T00:00:01.000Z",
    "finished_at": "2026-01-01T00:00:05.000Z"
  }
}
```

#### GET /api/admin/jobs/{jobId}/progress

Get just the progress counter for an import job (thin alias for shell scripts).

### 5.8 Admin Misc

#### GET /api/admin/logs

Get access logs for a skill.

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `skill_slug` | string | **Required.** Skill slug to query |
| `limit` | number | Max log entries (default: 50, max: 200) |

#### GET /api/admin/stats

Get server statistics.

**Response**:
```json
{
  "success": true,
  "data": { "totalSkills": 5 }
}
```

---

## 6. Gateway API Endpoints

All Gateway endpoints require **JWT Bearer Token** authentication. The gateway validates the JWT and resolves the user's identity and permissions. Legacy API key tokens are also supported for backward compatibility.

```bash
Authorization: Bearer <jwt_access_token>
```

### GET /api/gateway/health

Simple health check for the gateway service.

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2026-04-29T10:00:00.000Z"
}
```

### GET /api/gateway/skills

List all available skills accessible to the authenticated user (equivalent to `skill_list` MCP tool).

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `offset` | number | Pagination offset (default: 0) |
| `limit` | number | Page size (default: 50) |
| `category` | string | Filter by category |
| `tags` | string | Comma-separated tag list (AND match) |
| `attributes.*` | string | Filter by dynamic attribute, e.g. `attributes.framework=react` |

**Request**:
```bash
curl -H "Authorization: Bearer <token>" \
  "http://storage:3000/api/gateway/skills?offset=0&limit=50&category=writing"
```

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "slug": "prompt-writer",
      "description": "Professional prompt writing and optimization"
    }
  ],
  "total": 1,
  "offset": 0,
  "limit": 50
}
```

### GET /api/gateway/skills/{identifier}

Get skill metadata. The `{identifier}` parameter accepts either a **slug** (kebab-case string) or a **UUID** (36-character hex string with dashes).

**Request**:
```bash
curl -H "Authorization: Bearer <token>" \
  http://storage:3000/api/gateway/skills/prompt-writer
```

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "slug": "prompt-writer",
    "name": "prompt-writer",
    "description": "Professional prompt writing...",
    "version": "0.0.1",
    "status": "published",
    "visibility": "public"
  }
}
```

> **Note**: This endpoint returns skill metadata only. To load the SKILL.md entry content, use the dedicated `/api/gateway/skills/{slug}/entry` endpoint below.

### GET /api/gateway/skills/{slug}/entry

Get the entry file (SKILL.md) content as raw markdown.

**Response**: Raw markdown content (`Content-Type: text/markdown; charset=utf-8`)

### POST /api/gateway/skills/{slug}/files

Batch-read supporting files from a skill.

**Request**:
```bash
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "paths": [
      "references/crispe-framework.md",
      "templates/checklist.md"
    ]
  }' \
  http://storage:3000/api/gateway/skills/prompt-writer/files
```

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "path": "references/crispe-framework.md",
      "content": "# CRISPE Framework\n\n**C** = Clarity...",
      "encoding": "utf-8"
    },
    {
      "path": "templates/checklist.md",
      "content": "# Self-Check Checklist\n\n- [ ] Clarity...",
      "encoding": "utf-8"
    }
  ]
}
```

**Response Object Fields** (`SkillFileContent`):

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | File path relative to skill root |
| `content` | string | File content (raw UTF-8 or base64-encoded) |
| `encoding` | `"utf-8" \| "base64"` | Content encoding |
| `mimeType` | string? | MIME type (present for binary files) |

### GET /api/gateway/skills/{slug}/file-tree

Get the file tree structure of a skill.

---

## 7. Kubernetes Probe Endpoints

These endpoints are used by kubelet for health checking in k8s deployments.

### GET /api/livez

**Liveness probe.** Returns 200 as long as the process event loop is responsive. No I/O or DB calls. Used by kubelet to decide whether to restart the pod.

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2026-04-29T10:00:00.000Z"
}
```

### GET /api/readyz

**Readiness probe.** Returns 200 only when dependencies (DB) are reachable. A `SELECT count(*) FROM skills` round-trip verifies the SQLite connection is healthy. Used by kubelet to gate Service endpoint inclusion.

**Response** (ready):
```json
{
  "status": "ok",
  "checks": {
    "db": { "ok": true, "latencyMs": 1 }
  }
}
```

**Response** (not ready — HTTP 503):
```json
{
  "status": "not_ready",
  "checks": {
    "db": { "ok": false, "latencyMs": 5, "error": "SQLITE_CANTOPEN" }
  }
}
```

---

## Error Handling

### Common Errors

| Status | Scenario | Message |
|--------|----------|---------|
| 401 | Missing/invalid token | `"error": "Authentication required"` |
| 403 | Non-admin accessing admin endpoint | `"error": "Admin privilege required"` |
| 404 | Skill not found | `"error": "Skill 'invalid-slug' not found"` |
| 400 | Invalid file path (traversal) | `"error": "Invalid file path"` |
| 500 | Server error | `"error": "Internal server error"` |

### Error Response Format

```json
{
  "success": false,
  "error": "Descriptive error message"
}
```

---

## Performance Characteristics

| Operation | Typical Latency | Cached? | Notes |
|-----------|-----------------|---------|-------|
| skill_list | <100ms | Yes (5-10m) | Fast index scan |
| skill_view | 50-500ms | Yes (10-30m) | First call slower |
| skill_file (1 file) | 10-100ms | Yes (5-10m) | Cached after first call |
| skill_file (3 files) | 30-150ms | Yes (5-10m) | Parallel loading |
| /api/gateway/* | ~50ms | Yes | HTTP overhead minimal |

---

## Version Compatibility

- **MCP Protocol**: 2024-11-05 and later
- **Node.js**: >= 22
- **API Stability**: Stable (backward compatible)
- **API Versioning**: `/api/v1/*` is the canonical prefix. Legacy unversioned paths are deprecated with a 6-month sunset window ending 2026-11-28.

---

## See Also

- [tech-dev-program.md](./tech-dev-program.md) - Detailed design rationale
- [TESTING_GUIDE.md](./TESTING_GUIDE.md) - How to test skill operations
- [CODE_REVIEW_FINDINGS.md](../CODE_REVIEW_FINDINGS.md) - Security considerations
