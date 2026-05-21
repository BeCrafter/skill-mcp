# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working with this repository. Combines behavioral guidelines and project-specific instructions.

## Coding Guidelines

Behavioral guidelines to reduce common LLM coding mistakes:

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan with verification steps. Strong success criteria let you loop independently.

---

### 5. Documentation Sync

**Keep README.md in sync with code changes.**

When making changes that affect:
- **CLI commands** — Add to README.md "CLI Commands Reference" section
- **MCP tools** — Add to README.md "MCP Tools" section  
- **Environment variables** — Add to README.md "Environment Variables" table
- **New features** — Update relevant sections in README.md

**Before committing**:
- Run `npm run docs:sync` to check if README.md is up to date
- Update README.zh.md (Chinese translation) when English version changes
- The pre-commit hook will automatically check and prompt if docs need updating

**Docs sync locations**:
- CLI commands: `src/cli/commands/*.ts` → README.md "CLI Commands Reference"
- MCP tools: `src/mcp/tools/*.ts` → README.md "MCP Tools"
- Environment vars: `src/config/schema.ts` → README.md "Environment Variables"
- Sync script: `scripts/sync-docs.js` validates all above

---

## Build & Run Commands

```bash
npm run build          # Compile TypeScript (tsc)
npm run dev            # Watch-mode compilation
npm start              # Run the server (default: stdio transport)
npm run serve          # Alias for `node dist/index.js serve`
npm test               # Run all tests (vitest run)
npm run test:watch     # Tests in watch mode
npm run test:coverage  # Coverage report (v8)
npm run lint           # ESLint on src/
npm run lint:fix       # ESLint with auto-fix
```

Run a single test file:
```bash
npx vitest run tests/unit/utils/security.test.ts
```

Run tests matching a pattern:
```bash
npx vitest run -t "scanForInjection"
```

## Architecture

This is an **MCP (Model Context Protocol) server** that manages reusable skill packages for AI assistants. It exposes three MCP tools (`skill_list`, `skill_view`, `skill_file`) and supports stdio, SSE, and Streamable HTTP transports.

### Layered data flow

```
CLI / MCP Client → SkillService → ISkillProvider → IStorageProvider → filesystem
                                      ↕
                               ICacheProvider (L1 memory LRU + L2 file)
```

**SkillService** (`src/services/skill.service.ts`) is the core business logic layer. It delegates to `ISkillProvider` (which abstracts local vs remote skill access), applies `IPermissionFilter`, runs security scans via `scanForInjection`, and wraps cache lookups.

**ISkillProvider** (`src/provider/interface.ts`) has two implementations: `LocalProvider` (reads from local storage) and `RemoteProvider` (proxies to a gateway/cloud service in gateway deployment mode).

### Key patterns

- **Config singleton** — `getConfig()` in `src/config/index.ts` loads once: env vars first, then deep-merges a JSON config file (path from `SKILL_MCP_CONFIG`). Validated with Zod (`src/config/schema.ts`).
- **Two-layer cache** — `CompositeCacheProvider` chains L1 (memory LRU) → L2 (file-based). L2 TTL is multiplied by `l2TtlMultiplier` (default 2x).
- **Import pipeline** — `SkillImporter` delegates to `LocalSource` or `GitSource` to read files, runs `validateSkillPackage()` (manifest validation + security scan), then persists via repositories. Version bumps are content-hash based.
- **Raw HTTP server** — `src/app.ts` uses Node's `http.createServer` (not Fastify) so MCP SDK transport handlers receive unconsumed request/response streams. Admin REST routes (`/api/*`) are handled inline in the same server.
- **DB** — Drizzle ORM + better-sqlite3. Schema in `src/db/schema.ts`, repositories in `src/db/repositories/`. Migrations via `npm run db:migrate`.

### Config & storage

Config can come from env vars (e.g. `DATABASE_PATH`, `TRANSPORT_TYPE`, `STORAGE_TYPE`) or a `skill-mcp.config.json` file. Storage backends: `local-fs` (default, `./data/skills`) or `aliyun-oss`. All data dirs are auto-created on startup.

**Skill storage organization**:
- Skills are organized by **slug** (kebab-case), not by name
- Physical path: `STORAGE_BASE_PATH/{slug}/` (e.g. `./data/skills/prompt-writer/`)
- Database: `skills.storage_path` stores relative path `{slug}/`
- This enables collision detection: duplicate skill names are rejected unless `--overwrite` is used

### Deployment Modes: Architecture Design Decisions

This project implements **single binary, dual-mode deployment** rather than separate Gateway/Cloud services (as described in `tech-dev-program.md`).

**Why this design?**
- **Document Design**: tech-dev-program.md recommends separate Gateway and Cloud Service
- **Our Implementation**: Single binary with config-driven mode switching
- **Rationale**:
  1. Simplified development and testing (no IPC complexity)
  2. Reduced deployment overhead (single Docker image)
  3. Production flexibility (can be deployed separately via load balancer)
  4. Same interface (ISkillProvider abstraction ensures compatibility)

**How it works**:
```bash
# Standalone: All features in one process
DEPLOYMENT_MODE=standalone npm start

# Gateway: Uses RemoteProvider to call cloud service (local or remote)
DEPLOYMENT_MODE=gateway CLOUD_SERVICE_URL=http://... npm start

# Cloud Service Only: Pure data service (no MCP), HTTP only
DEPLOYMENT_MODE=cloud npm start --transport http

# MCP-only: Disables admin API (for security in production)
MCP_ONLY_MODE=true npm start
```

**Four Deployment Modes**:

| Mode | Purpose | Transport | API Routes | MCP Available | Use Case |
|------|---------|-----------|-----------|---|----------|
| **standalone** | All-in-one | stdio/http | Admin + Gateway | ✅ | Local dev, small deployments |
| **gateway** | Router layer | stdio/http | Gateway only | ✅ | Proxies to remote cloud service |
| **cloud** | Data service | http only | Admin + Gateway | ❌ | Backend in distributed setup |
| **MCP-only** | Client-facing | stdio/http | None | ✅ | Production MCP endpoint |

**Three Scenarios at a Glance**:

| Scenario | Mode | Transport | Best For | Config |
|----------|------|-----------|----------|--------|
| **A** | standalone | stdio | Local development | `.env.scenario-a` |
| **B** | gateway | stdio | Hybrid dev+remote | `.env.scenario-b-*` |
| **C1** | standalone | http | Unified HTTP server | `.env.scenario-c1` |
| **C2** | gateway | http | Distributed (production) | `.env.scenario-c2-*` |

**API Route Structure**:
- **Admin APIs**: `/api/admin/*` (internal management, e.g. `/api/admin/skills`, `/api/admin/stats`)
- **Gateway APIs**: `/api/gateway/*` (client-facing, e.g. `/api/gateway/skills`)
- **Legacy**: `/api/health` (backward compatibility only)

**Key Files for Each Scenario**:
- **Scenario A**: `src/provider/local.provider.ts`, `src/app.ts` (MCP routing only)
- **Scenario B**: `src/provider/remote.provider.ts`, API endpoints (`/api/gateway/*`)
- **Scenario C**: `docker-compose.scenarios.yml`, `nginx.conf`, multi-service setup

### When to Choose Each Mode

**Standalone Mode**:
- Use for: Local development, small independent deployments, fully self-contained systems
- Includes: MCP tools + Admin API + data storage
- Limitation: Single-process bottleneck at scale
- Example: Developer on laptop, or single small server

**Gateway Mode**:
- Use for: Multi-process communication, remote storage backends, distributed deployments
- Proxies to: Cloud Service or another remote instance
- Benefit: Separates routing layer from data layer
- Example: Client SDK → Gateway → Separate cloud service in different datacenter

**Cloud Service Only** (pure data service):
- Use for: Backend-only deployments, no MCP exposure, pure HTTP API
- Disables: MCP tools (no protocol buffer overhead)
- Best for: Storage backend in distributed architecture
- Example: Storage microservice behind internal load balancer

**MCP-Only** (client-facing):
- Use for: Production AI assistant integration, minimal attack surface
- Disables: Admin API (no management endpoints)
- Best for: Secure remote endpoint, read-only client access
- Example: Claude plugin or remote MCP endpoint

### Environment Variables Reference

**Application Configuration**:
- `NODE_ENV` — `"development"` | `"production"` (default: `"development"`)
- `DEPLOYMENT_MODE` — `"standalone"` | `"gateway"` | `"cloud"` (default: `"standalone"`)
- `MCP_ONLY_MODE` — `"true"` | `"false"` (disables `/api/admin/*` routes, default: `"false"`)
- `LOG_LEVEL` — `"trace"` | `"debug"` | `"info"` | `"warn"` | `"error"` (default: `"info"`)

**Storage Configuration**:
- `STORAGE_TYPE` — `"local-fs"` | `"aliyun-oss"` (default: `"local-fs"`)
- `STORAGE_BASE_PATH` — Filesystem path to skills directory (default: `"./data/skills"`)
- `ALIYUN_ACCESS_KEY_ID` — OSS access key (required if `STORAGE_TYPE=aliyun-oss`)
- `ALIYUN_ACCESS_KEY_SECRET` — OSS secret key (required if `STORAGE_TYPE=aliyun-oss`)
- `ALIYUN_BUCKET` — OSS bucket name (default: `"skill-mcp"`)
- `ALIYUN_REGION` — OSS region (default: `"oss-cn-hangzhou"`)

**Database Configuration**:
- `DATABASE_PATH` — SQLite database file path (default: `"./data/skill-mcp.db"`)
- `DATABASE_TIMEOUT` — Query timeout in milliseconds (default: `"5000"`)

**Transport Configuration**:
- `TRANSPORT_TYPE` — `"stdio"` | `"sse"` | `"http"` (default: `"stdio"`)
- `TRANSPORT_PORT` — Port for HTTP/SSE transport (default: `"3000"`)
- `TRANSPORT_HOST` — Host for HTTP/SSE transport (default: `"0.0.0.0"`)

**Gateway Configuration** (only when `DEPLOYMENT_MODE=gateway`):
- `CLOUD_SERVICE_URL` — Base URL of remote cloud service (required, e.g., `"http://localhost:3001"`)
- `AUTH_TOKEN` — Static bearer token for cloud service calls (optional)
- `AUTH_TOKEN_REFRESH_URL` — URL to refresh token (optional, used if token expires)

**Cache Configuration**:
- `CACHE_MEMORY_ENABLED` — `"true"` | `"false"` (default: `"true"`)
- `CACHE_MEMORY_MAX_SIZE` — Max entries in memory cache (default: `"1000"`)
- `CACHE_FILE_ENABLED` — `"true"` | `"false"` (default: `"true"`)
- `CACHE_FILE_DIR` — Directory for file-based cache (default: `"./data/cache"`)
- `CACHE_L2_TTL_MULTIPLIER` — TTL multiplier for L2 cache (default: `"2"`)

**Security Configuration**:
- `SECURITY_INJECTION_SCAN` — `"true"` | `"false"` (enable prompt injection detection, default: `"true"`)
- `SKILL_MCP_AUTH_TOKEN` — Stdio mode bearer token used for permission isolation. Resolved per-request via `buildRequestContext` (sha256 → user lookup → tag aggregation). CLI flag `--auth-token` overrides. When unset and the DB has active users or non-public skills, `serve --transport stdio` exits with an error.

**Access Control (RBAC)**:
- API Key authentication has been removed. All HTTP/SSE callers authenticate with per-user bearer tokens issued by `skill-mcp user create`.
- Roles carry tag lists (`skill-mcp role create --tags ...`); user→role joins produce the request-context tag set.
- `TagPermissionFilter` enforces visibility:
  - `visibility="public"` — visible to anyone, including anonymous callers.
  - `visibility="internal"` — visible to any authenticated user.
  - `visibility="private"` (default) — empty `tags` means visible to any authenticated user; non-empty `tags` requires intersection with the caller's role tags.
- Skills default to `visibility="private"` at all three layers (Drizzle schema, SQL migration, repository fallback). Mark a skill `public` (Admin API or DB) to expose it to anonymous traffic.
- Service accounts: reuse the user table; convention is to name them `svc-<role>` so admins can spot machine identities at a glance.

### Scenario-Specific Configurations

**Scenario A: Local Development (stdio)**

```bash
# .env.scenario-a
DEPLOYMENT_MODE=standalone
TRANSPORT_TYPE=stdio
STORAGE_TYPE=local-fs
STORAGE_BASE_PATH=./data/skills
DATABASE_PATH=./data/skill-mcp.db
LOG_LEVEL=debug
CACHE_MEMORY_ENABLED=true
CACHE_FILE_ENABLED=true
```

**Scenario B: Hybrid Dev + Remote (localhost stdio → remote HTTP)**

```bash
# .env.scenario-b-local (local gateway redirects to remote)
DEPLOYMENT_MODE=gateway
TRANSPORT_TYPE=stdio
CLOUD_SERVICE_URL=http://cloud-service:3001
LOG_LEVEL=debug

# .env.scenario-b-cloud (remote service)
DEPLOYMENT_MODE=standalone
TRANSPORT_TYPE=http
TRANSPORT_PORT=3001
STORAGE_TYPE=local-fs
STORAGE_BASE_PATH=./data/skills
DATABASE_PATH=./data/skill-mcp.db
```

**Scenario C1: Unified HTTP Server**

```bash
# .env.scenario-c1
DEPLOYMENT_MODE=standalone
TRANSPORT_TYPE=http
TRANSPORT_PORT=3000
TRANSPORT_HOST=0.0.0.0
STORAGE_TYPE=local-fs
STORAGE_BASE_PATH=./data/skills
DATABASE_PATH=./data/skill-mcp.db
MCP_ONLY_MODE=false
```

**Scenario C2: Distributed Production (MCP → Gateway → Cloud Service)**

```bash
# .env.scenario-c2-mcp (client-facing MCP endpoint)
DEPLOYMENT_MODE=gateway
TRANSPORT_TYPE=http
TRANSPORT_PORT=4000
TRANSPORT_HOST=0.0.0.0
CLOUD_SERVICE_URL=http://gateway-lb:3001
MCP_ONLY_MODE=true
LOG_LEVEL=info

# .env.scenario-c2-gateway (routing layer)
DEPLOYMENT_MODE=gateway
TRANSPORT_TYPE=http
TRANSPORT_PORT=3001
CLOUD_SERVICE_URL=http://cloud-service:3002
LOG_LEVEL=info

# .env.scenario-c2-cloud (data service backend)
DEPLOYMENT_MODE=cloud
TRANSPORT_TYPE=http
TRANSPORT_PORT=3002
STORAGE_TYPE=aliyun-oss
ALIYUN_ACCESS_KEY_ID=<your-key>
ALIYUN_ACCESS_KEY_SECRET=<your-secret>
ALIYUN_BUCKET=skill-mcp
DATABASE_PATH=/data/skill-mcp.db
```

### Skill package format

A skill package directory must contain `manifest.json` (with `name`, optional `version`/`entry`/`files`) and an entry file (default `SKILL.md`). Only text-based file extensions are accepted (enforced by `isTextFile()`).

## Code Conventions

- **ESM** — `"type": "module"`, `Node16` module resolution. All local imports use `.js` extensions.
- **TypeScript strict** — `strict: true`, `ES2024` target. No `any` without a lint warning.
- **Tests** — Vitest with globals enabled, `@` alias maps to `src/`. Tests live in `tests/unit/` mirroring `src/` structure.
- **ESLint** — Uses `typescript-eslint` with recommended configs. Ignores `dist/`, `node_modules/`, `tests/`.
- **Node.js >= 22** required.

---

## Git Hooks

The project has intelligent pre-commit hooks configured to ensure documentation stays in sync:

- **`.git/hooks/pre-commit`** — Automatically runs `npm run docs:sync --check-new-only` when committing
- **Smart detection**: Only prompts for docs update when you add NEW files:
  - New CLI command: `src/cli/commands/*-cmd.ts`
  - New MCP tool: `src/mcp/tools/*.ts`
  - Config changes: `src/config/schema.ts`
- Refactors and bug fixes won't trigger the hook (no docs needed)
- Run `npm run docs:sync` for full documentation sync check at any time

---
