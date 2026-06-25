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

### 4.1 Nullable Field Safety (强制)

**禁止直接访问可能为 null/undefined 的字段，必须先做防御性处理。** 此规范源于 `new Date(creds.expiresAt).toISOString()` 在 `expiresAt` 为 undefined 时崩溃的真实事故。

**必须遵守的规则：**

1. **`new Date(x)` — 必须先校验 x**
   ```ts
   // ❌ 错误：x 可能是 null/undefined/NaN
   new Date(x).toISOString()

   // ✅ 正确：先守卫
   x != null ? new Date(x).toISOString() : fallback
   ```

2. **可空字段的 `.slice()` / `.length` / 模板字符串 — 必须用 `?? ""` 兜底**
   ```ts
   // ❌ 错误：description 可能为 null，模板字面量会输出 "null"
   const desc = s.description.slice(0, 80);
   return `${name}: ${desc}`;

   // ✅ 正确：统一用 ?? "" 兜底
   const desc = (s.description ?? "").slice(0, 80);
   return `${name}: ${desc}`;
   ```

3. **`JSON.parse()` — 外部输入必须 try/catch**
   ```ts
   // ❌ 错误：格式错误直接 500
   const data = JSON.parse(body);

   // ✅ 正确：返回 400
   let data;
   try { data = JSON.parse(body); } catch { throw new BadRequestError("Invalid JSON"); }
   ```

4. **数值字段做 Date/算术运算 — 必须检查 `Number.isFinite()`**
   ```ts
   // ❌ 错误：NaN 会传播到所有后续计算
   new Date(timestamp).getUTCFullYear()

   // ✅ 正确
   if (!Number.isFinite(timestamp)) return fallback;
   ```

5. **非空断言 `!` — 禁止用于 DB 可空字段**
   ```ts
   // ❌ 错误：schema 没有 .notNull()，运行时可能真是 null
   contentHash: skill.contentHash!

   // ✅ 正确
   contentHash: skill.contentHash ?? ""
   ```

**自查清单（提交前必须确认）：**
- 所有 `new Date()` 调用的参数是否有 null/undefined/NaN 守卫？
- 所有 DB 可空字段（schema 中无 `.notNull()`）在使用前是否有 `??` 兜底？
- 所有 `JSON.parse()` 处理外部输入时是否有 try/catch？
- 是否存在对可空字段使用非空断言 `!` 的情况？

---

### 5. Architecture Documentation Sync (强制)

**`docs/ARCHITECTURE.md` 是本项目唯一、完整的技术架构文档（Single Source of Truth）。每次会话执行编码任务时都必须遵守以下规则：**

1. **进入任何非平凡任务前**：先读 `docs/ARCHITECTURE.md`，确认当前模块的预期分层、依赖方向、横切契约。本文档优先级高于其它 `docs/` 子文件。
2. **下列变更必须在同一 PR 中同步更新 `docs/ARCHITECTURE.md`**：
   - 新增 / 删除 / 重命名 `src/` 一级目录或公共接口
   - 模块拆分、分层调整、依赖方向变化
   - 数据模型（drizzle schema、迁移）变化
   - 部署形态、模式开关（`DEPLOYMENT_MODE` / `MCP_ONLY_MODE` 等）语义变化
   - 横切关注点变化：认证 / 缓存键约定 / 事件类型 / 权限规则 / 配置 schema
   - 新增运行时 npm 依赖
3. **修复 `docs/ARCHITECTURE.md` 第 9 节"已知问题清单"中的任何条目时**，必须在同一 PR 中将该条目从清单移除或标注为 `已修复 (commit <sha>)`。完成第 10 节路线图中的某项时同样要更新。
   - **执行优化任务时，先读 [`docs/REFACTORING_BACKLOG.md`](docs/REFACTORING_BACKLOG.md)**，按其中的 T-XXX 条目逐项推进。每条目完成后：①把该条目状态改为 `✅ 已完成 (<commit-sha>, <date>)` 并移到"完成历史"章节（保留完整内容，不删）；②同步更新 `ARCHITECTURE.md` 第 9 / 10 节。
   - 接到优化类需求时，禁止凭印象动手，必须先在 BACKLOG 中找到对应条目；若无对应条目，先按 BACKLOG 末尾的"新增条目模板"补齐再开工。
4. **禁止把架构相关说明拆分到其它新文档**。架构图、模块清单、关键流程、问题清单、优化路线图必须留在 `docs/ARCHITECTURE.md` 同一份文件。需要更深入的子主题（RFC / 设计权衡）时，可在 `docs/ADVANCED/` 下新增，但必须从 `docs/ARCHITECTURE.md` 链接过去。
5. **职责边界**：README 面向使用者（怎么跑），`docs/ARCHITECTURE.md` 面向开发者与架构师（怎么实现、为何这样、还能怎样）。不要把架构内容写进 README，也不要把使用说明写进 ARCHITECTURE。
6. **文档末尾"变更日志"必须追加一行**：日期、commit sha、变更摘要。
7. **PR 自检清单**：提交前自问"我的改动是否触及第 2 条列出的任何范围？"，是 → 必须改 `docs/ARCHITECTURE.md`，否则视为未完成。

---

### 5.1 Permission Control (强制)

**`docs/PERMISSION_CONTROL.md` 是系统权限管控的唯一权威来源。** 任何涉及用户管理、角色管理、权限校验的开发必须严格遵循该文档。

1. **开发前必读**：进入任何涉及 `user`/`role`/`auth` 相关改动前，先读 `docs/PERMISSION_CONTROL.md`，确认当前权限矩阵和边界规则。
2. **下列变更必须同步更新 `docs/PERMISSION_CONTROL.md`**：
   - 用户类型（superadmin/admin/user）的增减或语义变化
   - 内置角色列表变化
   - 任何权限矩阵的调整（谁能对谁做什么）
   - 新增或修改 `requireSuperadmin` / `assertSuperadminProtected` 守卫
   - 新增管理员 API 端点（`/api/admin/*`）
   - CLI 管理命令的权限逻辑变更
3. **验证用例必须覆盖**：权限相关改动必须在 `docs/PERMISSION_CONTROL.md` 的验证用例中新增对应 TC，并实际执行验证。
4. **禁止绕过**：不允许在未更新文档的情况下修改权限逻辑。PR 自检时必须确认权限文档已同步。

---

### 6. Documentation Sync

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
- `/api/gateway/*` is gated by `enforceGatewayAuth` middleware (`src/http/middleware/gateway-auth.ts`). Missing or invalid `Authorization: Bearer <token>` returns `401` *before* the handler runs. Only `GET /api/gateway/health` is exempt for LB / k8s liveness probes.
- Roles carry tag lists (`skill-mcp role create --tags ...`); user→role joins produce the request-context tag set.
- `TagPermissionFilter` then enforces visibility *after* the caller is authenticated:
  - `visibility="public"` — visible to any authenticated caller (anonymous still 401's at the gateway).
  - `visibility="internal"` — visible to any authenticated user.
  - `visibility="private"` (default) — empty `tags` means visible to any authenticated user; non-empty `tags` requires intersection with the caller's role tags.
- Skills default to `visibility="private"` at all three layers (Drizzle schema, SQL migration, repository fallback). Mark a skill `public` (Admin API or DB) to expose it broadly within the platform.
- Service accounts: reuse the user table; convention is to name them `svc-<role>` so admins can spot machine identities at a glance. Gateway → Cloud Service internal calls should use a dedicated `svc-gateway` user whose token is configured in the gateway's `AUTH_TOKEN` env var.
- stdio transport bypasses the HTTP middleware; it instead resolves a token at process startup from `--auth-token` / `SKILL_MCP_AUTH_TOKEN` and injects it via `withFallbackToken`.

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
