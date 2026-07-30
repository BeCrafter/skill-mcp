# Architecture

本项目唯一、完整的技术架构文档（Single Source of Truth）。开发者与架构师读本。使用说明见 README，发布范围契约见 `releases/v0.1.md`。

> v0.1 是单进程、本地 SQLite + local-fs 的权限化 Skill Registry，承诺 BM25 `skill_search`、同步导入、版本回滚、缓存、RBAC、stdio/SSE/Streamable HTTP，以及 C2 远程代理（`CLOUD_SERVICE_URL` + `RemoteSkillProvider`）。

---

## 1. 分层与数据流

```
CLI / MCP Client ──► SkillService ──► ISkillProvider ──► IStorageProvider ──► filesystem
                         │                   (Local | Remote)        (local-fs)
                         │                   ↕
                         ├─► ICacheProvider (L1 memory LRU + L2 file)
                         ├─► IPermissionFilter (TagPermissionFilter)
                         └─► scanForInjection (security)
```

- **SkillService**（`src/services/skill.service.ts`）核心业务层：委托 `ISkillProvider`（抽象本地/远程访问）、应用 `TagPermissionFilter`、安全扫描、包装缓存；`searchAccessibleSkills` 在代理模式委派 `remoteSearch`。
- **ISkillProvider**（`src/provider/interface.ts`）：`LocalSkillProvider`（本地 SQLite+fs）/ `RemoteSkillProvider`（C2 代理到远端 storage，`skill_search` 委派到 `/api/gateway/skills/search`）。

## 2. 模块清单（`src/`）

| 目录 | 职责 |
|------|------|
| `cli/` | CLI 命令（`index.ts` 注册；`commands/*-cmd.ts` 实现） |
| `config/` | 配置单例 `getConfig()`；Zod schema；`rejectRemovedEnvironment` |
| `cache/` | `CompositeCacheProvider`（L1 内存 LRU → L2 文件）；`cache-epochs.ts` 版本化失效 |
| `db/` | Drizzle schema、迁移（`migrate.ts` fail-closed）、repositories |
| `events/` | `DomainEventBus`；`cache-subscriber.ts` 缓存失效 |
| `http/` | 路由、中间件（`admin-auth`/`gateway-auth`/`rate-limit`）、handlers、OpenAPI spec |
| `import/` | `SkillImporter`（`LocalSource`/`GitSource`）、`validateSkillPackage` |
| `mcp/` | MCP 工具（5 个）、server、transport（stdio/sse/http）、prompts |
| `permission/` | `context-builder`、`TagPermissionFilter` |
| `provider/` | `LocalSkillProvider`、`RemoteSkillProvider`、`instrument` |
| `retrieval/` | `BM25Index`（内存 BM25） |
| `services/` | `SkillService`、`SkillSearchService`、`AccessLogService` |
| `storage/` | `LocalFileSystemProvider` |
| `telemetry/` | Prometheus 指标 |
| `types/` | 共享 TS 接口（`SkillMeta`、`RequestContext` 等） |
| `utils/` | manifest 解析、security、logger、errors |

## 3. 关键流程

### 3.1 导入（同步）
`SkillImporter.import` → 解析源（本地/Git）→ `validateSkillPackage`（manifest + 注入扫描）→ `computeContentHash` → 持久化（版本哈希驱动 bump）→ `publish(skill:imported)` → **`await onMutation(slug)`**（刷新 BM25 索引，保证返回前可检索）。

### 3.2 搜索（BM25 + RBAC）
`skill_search` → `SkillService.searchAccessibleSkills` → 先 `getAccessibleSkillsForUser`（生命周期 `published` + `TagPermissionFilter`）→ 传入 `allowedSkillIds` → `BM25Index.search` **先过滤候选再评分、排序、截断**（私有高分结果不挤占可见结果）。语料 = name + description + triggers + when_to_use + embedding_text。`mode`/`hybridAlpha` 兼容接受但忽略。

### 3.3 C2 远程代理
`serve` 读 `CLOUD_SERVICE_URL` → 构造 `RemoteSkillProvider`（代理 skill 读写）；`SkillService.remoteSearch` 委派到 storage 的 `/api/gateway/skills/search`（BM25+RBAC 在 storage 侧）；代理节点跳过本地 `skillSearchService.init()`。mcp 节点配 `MCP_ONLY_MODE`。

### 3.4 认证与 RBAC
- HTTP：`enforceAdminAuth`（admin 路由）/ `enforceGatewayAuth`（gateway 路由）解析 `Authorization: Bearer <token>` → `buildRequestContextFromHttp` → `RequestContext`。
- 用户变更守卫 `assertCanOperateOn`（`users.handler.ts`）：超管互保（仅可操作自身）、admin 仅可操作自身、其余需 superadmin。**自我操作（自改/自删/自轮换）在 HTTP 路径允许**；CLI `assertCanOperateOnCli` 额外拦截自删。
- 详见 `permission-control.md`。

### 3.5 缓存失效
`CacheEpochManager` 版本后缀 `g{global}:u{user}` 折入 `skill:list:` 缓存键；变更 bump epoch 失效。`cache-subscriber` 订阅 `skill:*` 事件 clearByPrefix + epoch bump。

## 4. 数据模型

Drizzle ORM + better-sqlite3。schema 在 `src/db/schema.ts`，迁移在 `drizzle/`（仅 `0000_baseline.sql`，无 DROP）。

**兼容性 tombstone 表**（声明保留、无 v0.1 repository/写入路径、不得生成 DROP migration）：`import_jobs`、`usage_events`、`pipeline_runs`、`webhooks`、`webhook_deliveries`、`skill_eval_cases`、`skill_eval_runs`、`skill_embeddings`。

**fail-closed**：`assertSafeMigrationState`（`migrate.ts`）对无 `__drizzle_migrations` 账本的非空 legacy 库直接报错，不 DROP、不改数据。

## 5. 部署形态

| 形态 | 触发 | 说明 |
|------|------|------|
| A 本地 stdio | `serve`（默认） | 个人 IDE/Agent |
| C1 单机 HTTP | `serve --transport http` | 全功能单进程 |
| C2 分布式 | `CLOUD_SERVICE_URL` + `MCP_ONLY_MODE`/`API_ONLY_MODE` | storage 权威库 + mcp 代理 + Caddy |
| backend | `--api-only` | REST 管理自动化 / C2 的 storage |

`--mcp-only`/`--api-only` 互斥。`DATABASE_URL` 与非 `local-fs` `STORAGE_TYPE` 启动报错；`CLOUD_SERVICE_URL` 允许（C2）。详见 `deployment/`。

## 6. 配置

`getConfig()` 单例：env → JSON 配置（`SKILL_MCP_CONFIG`）deep-merge → Zod 校验。`gateway.cloudServiceUrl`（`CLOUD_SERVICE_URL`）启用 C2。完整 env 见 `.env.example`。

## 7. 横切关注点

- **认证**：bearer token（sha256 存储）/ JWT（admin login）。stdio 用 `--auth-token`/`SKILL_MCP_AUTH_TOKEN`。
- **缓存键**：`skill:list:<userId>:<epoch>`、`skill:entry:<slug>`、`skill:file:<slug>:<path>`、`skill:filetree:<slug>`。
- **事件**：`skill:created`/`updated`/`deleted`/`imported`。
- **权限**：三级 `superadmin`/`admin`/`user`；角色带 tags；`TagPermissionFilter` 按 `visibility`+tags 过滤。

## 8. 运行保障

`/api/health`（无鉴权，供 LB/容器探针）、限流、结构化日志、经鉴权 Prometheus `/metrics`。

---

## 9. 已知问题清单

| ID | 问题 | 状态 |
|----|------|------|
| K-1 | RBAC 自删/自改/自轮换在 HTTP 路径允许（`assertCanOperateOn` 自我豁免）；仅 CLI 拦截自删 | ✅ 已修复（`assertCanOperateOn`/`assertCanOperateOnCli` 加 `mutate` 形参：admin 不可变更任何 admin 含自己；DELETE 加自删守卫，HTTP+CLI 一致拦截自删；`tests/integration/rbac-matrix.test.ts` 18 用例验证） |
| K-2 | `verify.sh` 注记 Caddy v2 `header_up` 转发不稳定，绕过用直连/网络内测试 | 运行时注记 |
| K-3 | `docs:sync` 脚本曾对冒号子命令 `manifest:migrate` 误报 | 已修复（脚本兼容冒号） |
| K-4 | RBAC 验收 TC 曾为文档脚本、未自动化 | 已修复（`tests/integration/rbac-matrix.test.ts`，17 用例） |
| K-5 | `docs/ARCHITECTURE.md`、`refactoring-backlog.md`、`advanced/` 曾缺失 | 已恢复（见 §10） |

## 10. 路线图

post-v0.1 作为独立、独立验收的功能恢复（不得仅通过重新暴露旧配置/参数启用）：

- 向量/embedding/混合检索：持久化 vector store、历史回填/删除/版本收敛、权限感知查询、端到端 migration。
- 远程存储（OSS）：可观测错误语义、原位迁移。
- Eval / Pipeline / Webhook / Usage ledger / OpenTelemetry / 自升级 / PostgreSQL：各自独立设计+验收。

C2 远程代理已在 v0.1 恢复（新产品决策 + e2e）。

---

## 变更日志

- 2026-07-31 · 创建 v0.1+C2 版 ARCHITECTURE.md（SSOT 恢复），含模块清单、关键流程、已知问题、路线图。
- 2026-07-31 · K-1 安全加固：`assertCanOperateOn`/`assertCanOperateOnCli` 加 `mutate` 形参 + HTTP DELETE 自删守卫，恢复「自删/自改/自轮换」不变量（HTTP 与 CLI 一致）。
