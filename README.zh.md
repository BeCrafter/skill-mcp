# Skill MCP Server

**云技能文件系统与 MCP 权限网关**

一个为 AI 助手提供托管技能文件系统的模型上下文协议 (MCP) 服务器。通过标准 MCP 工具导入、版本化和服务可重用技能包，内置安全扫描、RBAC 和流程编排功能。

## 功能特性

- **MCP 协议** — 将技能作为 MCP 工具暴露，兼容任何 MCP 客户端
- **多传输方式** — 支持 stdio、SSE 和可流式 HTTP 传输
- **流程编排引擎** — 基于 DAG 的技能编排，支持并行执行
- **三级 RBAC** — 超级管理员 / 管理员 / 用户，支持基于角色标签的权限控制
- **JWT 认证** — 管理员通过用户名+密码登录，获取 JWT access/refresh token
- **CLI 双模式** — 本地 DB 直连或通过 `--server-url` 远程 HTTP API
- **技能反馈** — 收集技能效果反馈，以数据驱动改进
- **技能导入** — 从本地目录或 Git 仓库导入技能包
- **安全扫描** — 对所有导入的技能内容进行内置提示词注入检测
- **版本管理** — 自动语义版本控制，基于内容哈希跟踪和回滚支持
- **缓存** — 分层内存（LRU）+ 文件缓存，实现快速技能检索
- **SQLite 存储** — 通过 Drizzle ORM + better-sqlite3 持久化元数据
- **语义检索** — BM25 关键词搜索（默认），可选向量/混合检索（OpenAI/Ollama embeddings）
- **Webhooks** — 出站 Webhook 订阅，支持 HMAC 签名、重试队列和投递追踪
- **OpenAPI & Swagger** — 内置 API 文档，HTTP 模式下可通过 `/api/docs` 访问
- **审计日志** — 自动记录技能变更操作，包含变更前后的快照
- **异步导入** — 后台任务队列，支持从远程源异步导入技能
- **评估框架** — 为 skill 定义测试用例，支持自动回归门禁
- **指标与追踪** — Prometheus 指标（`/metrics`）和可选 OpenTelemetry 追踪
- **CLI 管理** — 完整的命令行界面，用于导入、列出、搜索和管理技能
- **自升级检查** — `skill-mcp upgrade` 可检查 npm registry + 镜像的新版本

## 📚 文档导航

### 针对不同角色

**👨‍💻 新手开发者**
1. 从 [快速开始](./docs/QUICK_START.md) 开始（5 分钟）
2. 阅读 [贡献指南](./CONTRIBUTING.md)（开发流程）
3. 查看 [Claude Code 指南](./CLAUDE.md)（IDE 设置）

**🚀 DevOps / 部署**
- [生产部署](./docs/PRODUCTION_DEPLOYMENT.md) — 生产环境设置
- [场景](./docs/SCENARIOS/) — 不同的部署模式 (A/B/C)

**🏗️ 架构师 / 维护者**
- [架构概览](./docs/ARCHITECTURE.md) — 系统设计
- [组织规则](./docs/ORGANIZATION.md) — 代码结构
- [API 参考](./docs/API_REFERENCE.md) — MCP 工具 & REST API
- [高级主题](./docs/ADVANCED/) — 流程编排引擎、RBAC、技术规范

**🧪 QA / 测试**
- [测试指南](./docs/TESTING_GUIDE.md) — 如何运行测试

**📖 其他资源**
- [代码组织分析](./docs.local/CODE_ORGANIZATION_ANALYSIS.md) — 代码库结构分析

## 前置要求

- Node.js >= 22.0.0

## 安装

```bash
npm install
npm run build
```

## 📂 数据存储位置

默认情况下，所有技能数据、数据库和缓存文件存储在你的用户主目录中：

```
~/.skill-mcp/
├── data/
│   └── skills/          # 技能包
├── skill-mcp.db         # SQLite 数据库
└── cache/               # 文件缓存
```

这意味着 **skill-mcp 可以在任何目录下运行** —— 你可以在任意文件夹执行 `skill-mcp list` 等命令并访问相同的数据。

## 📋 选择您的部署场景

本项目支持 **三种灵活的部署模式**：

| 场景 | 传输方式 | 存储 | 用途 |
|----------|-----------|---------|----------|
| **A** - 本地 | stdio | 本地 | 开发、单用户 |
| **B** - 混合 | stdio | 远程 | 本地 MCP + 共享存储 |
| **C** - 分布式 | HTTP | 本地/远程 | 生产、多客户端 |

👉 **[快速开始指南 →](./docs/QUICK_START.md)**

- **场景 A** - [本地开发](./docs/SCENARIOS/SCENARIO_A.md)
- **场景 B** - [混合部署](./docs/SCENARIOS/SCENARIO_B.md)
- **场景 C** - [分布式部署](./docs/SCENARIOS/SCENARIO_C.md)
- **完整架构** - [完整参考](./docs/ARCHITECTURE.md)

## 快速开始

### 1. 初始化系统（仅首次）

```bash
# 设置管理员登录的 JWT 密钥
export AUTH_JWT_SECRET=$(openssl rand -base64 32)

# 初始化系统，创建超级管理员账户
npx skill-mcp init --username admin --password YourStrongPassword

# 登录获取 JWT 凭证
npx skill-mcp auth login --username admin
```

### 2. 启动 MCP 服务器

```bash
# 场景 A: 本地 stdio（推荐用于开发）
npm start

# 场景 C: HTTP 服务器（生产环境）
TRANSPORT_TYPE=http npm start

# 代理模式：设置 CLOUD_SERVICE_URL 自动启用
CLOUD_SERVICE_URL=http://cloud-service:3001 npm start
```

### 2. 导入技能

```bash
# 从本地目录导入
npx skill-mcp import ./path/to/skill-package

# 从 Git 仓库导入
npx skill-mcp import https://github.com/org/skill-repo --branch main

# 带元数据导入
npx skill-mcp import ./my-skill --category "writing" --tags "prompt,creative"
```

### 3. 管理技能

```bash
# 列出所有技能
npx skill-mcp list

# 查看技能详情
npx skill-mcp info prompt-writer

# 搜索技能
npx skill-mcp search --name prompt

# 更新元数据
npx skill-mcp update prompt-writer --category "productivity" --display-name "Prompt Writer Pro"

# 查看版本历史
npx skill-mcp versions prompt-writer

# 回滚到之前的版本
npx skill-mcp rollback prompt-writer --to 0.0.1

# 删除技能
npx skill-mcp remove old-skill --force
```

### 4. 流程编排

```bash
# 验证流程 YAML
npx skill-mcp pipeline validate ./pipeline.yaml

# 可视化流程 DAG
npx skill-mcp pipeline graph ./pipeline.yaml

# 执行流程（试运行）
npx skill-mcp pipeline run ./pipeline.yaml --input pr_url=https://... --dry-run
```

### 6. RBAC 管理

```bash
# 创建角色
npx skill-mcp role create --name "data-team" --tags "data,analysis" --description "数据科学团队"

# 创建管理员用户（带登录凭证）
npx skill-mcp user create --name "Alice" --username alice --password Passw0rd --user-type admin --role-ids "role-uuid-1"

# 创建普通用户（仅 API token，无登录）
npx skill-mcp user create --name "Bob" --role-ids "role-uuid-1,role-uuid-2"

# 列出用户
npx skill-mcp user list

# 分配角色
npx skill-mcp user assign-roles user-id-1 --role-ids "role-uuid-1"

# 认证管理
npx skill-mcp auth whoami
npx skill-mcp auth logout
```

### 6. 技能检查

```bash
# 检查技能包目录
npx skill-mcp lint ./path/to/skill-package
```

## MCP 工具

| 工具 | 描述 |
|------|-------------|
| `skill_list` | 列出所有已发布的技能，支持可选过滤 |
| `skill_search` | 按名称、描述或内容相似度搜索技能 |
| `skill_view` | 查看特定技能的完整条目内容 |
| `skill_file` | 从技能包读取单个文件 |
| `skill_pipeline` | 执行流程（技能的 DAG 编排） |
| `skill_feedback` | 提交技能效果反馈 |

## 配置

配置从环境变量或 `skill-mcp.config.json` 文件加载（自动检测）。所有字段都有合理的默认值：

```jsonc
{
  "app": {
    "name": "skill-mcp",
    "env": "production",           // "development" | "production" | "test"
    "version": "0.0.1"
  },
  "deployment": {
    "mcpOnly": false,             // 如果为 true，仅 MCP + health（无 Admin/Gateway API）
    "apiOnly": false              // 如果为 true，仅 REST + health（无 MCP）
  },
  "gateway": {                    // 仅在代理到远程服务时使用
    "cloudServiceUrl": "http://cloud-service:3001",
    "authToken": "your-token"
  },
  "storage": {
    "type": "local-fs",         // 目前仅支持 "local-fs"
    "basePath": "./data/skills"
  },
  "database": {
    "path": "./data/skill-mcp.db"
  },
  "cache": {
    "memory": { "enabled": true, "maxSize": 500 },
    "file": { "enabled": true, "cacheDir": "./data/cache" }
  },
  "transport": {
    "type": "stdio",              // "stdio" | "sse" | "http"
    "port": 3000
  },
  "security": {
    "enableInjectionScan": true,
    "hstsEnabled": false
  }
}
```

### 环境变量

| 变量 | 描述 | 默认值 |
|----------|-------------|---------|
| `NODE_ENV` | 环境 | `development` |
| `MCP_ONLY_MODE` | 仅 MCP（禁用 Admin/Gateway API） | `false` |
| `API_ONLY_MODE` | 仅 REST（禁用 MCP） | `false` |
| `STORAGE_TYPE` | 存储后端 | `local-fs` |
| `STORAGE_BASE_PATH` | 技能目录 | `~/.skill-mcp/data/skills` |
| `DATABASE_PATH` | SQLite 数据库路径 | `~/.skill-mcp/skill-mcp.db` |
| `DATABASE_URL` | 数据库 URL（优先于 `DATABASE_PATH`） | - |
| `CACHE_MEMORY_ENABLED` | 启用内存 LRU 缓存 | `true` |
| `CACHE_MEMORY_MAX_SIZE` | 最大内存缓存条目数 | `500` |
| `CACHE_FILE_ENABLED` | 启用文件缓存 | `true` |
| `CACHE_FILE_DIR` | 缓存目录 | `~/.skill-mcp/cache` |
| `TRANSPORT_TYPE` | 传输类型 | `stdio` |
| `TRANSPORT_PORT` | HTTP 端口 | `3000` |
| `CLOUD_SERVICE_URL` | 远程服务 URL（自动启用代理模式） | - |
| `SKILL_MCP_AUTH_TOKEN` | stdio 认证 + 代理出站令牌 | - |
| `AUTH_JWT_SECRET` | 管理员登录的 JWT 签名密钥（最少 32 字符） | - |
| `SKILL_MCP_SERVER_URL` | CLI 远程模式的远程服务器 URL | - |
| `SECURITY_INJECTION_SCAN` | 启用 prompt injection 检测 | `true` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `OTEL_ENABLED` | 启用 OpenTelemetry tracing（`true` / `false`） | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP HTTP endpoint URL；未设时回落 `ConsoleSpanExporter` | - |
| `OTEL_SERVICE_NAME` | `service.name` 资源属性 | `skill-mcp` |
| `OTEL_SERVICE_VERSION` | `service.version` 资源属性 | package.json 版本 |
| `AUTH_JWT_ACCESS_EXPIRES_IN` | Access token 有效期（秒） | `7200`（2h） |
| `AUTH_JWT_REFRESH_EXPIRES_IN` | Refresh token 有效期（秒） | `604800`（7d） |
| `AUTH_JWT_ISSUER` | JWT issuer 声明 | `skill-mcp` |
| `RATE_LIMIT_ENABLED` | 限流总开关（`true` / `false`） | `true` |
| `RATE_LIMIT_ADMIN_CAPACITY` | 管理路由令牌桶容量 | `60` |
| `RATE_LIMIT_ADMIN_REFILL_PER_SEC` | 管理路由令牌补充速率（每秒） | `10` |
| `RATE_LIMIT_GATEWAY_CAPACITY` | 网关路由令牌桶容量 | `120` |
| `RATE_LIMIT_GATEWAY_REFILL_PER_SEC` | 网关路由令牌补充速率（每秒） | `20` |
| `SECURITY_HSTS_ENABLED` | 发送 `Strict-Transport-Security` header（仅在有 TLS 终端时启用） | `false` |
| `SKILL_MCP_METRICS_AUTH_OPTIONAL` | 允许不认证访问 `/metrics` | `false` |
| `SKILL_MCP_CONFIG` | JSON 配置文件路径（覆盖环境变量） | `~/.skill-mcp/config.json` |
| `SKILL_MCP_PKG_MANAGER` | `upgrade` 命令的包管理器覆盖 | 自动检测 |
| `OPENAI_API_KEY` | LLM 评估提供者的 OpenAI API 密钥 | - |
| `OPENAI_BASE_URL` | LLM 评估的 OpenAI 兼容 API URL | `https://api.openai.com/v1` |
| `OPENAI_EVAL_MODEL` | LLM 评估提供者的模型名称 | `gpt-4o-mini` |

### Stdio 模式权限隔离

stdio 传输没有 HTTP header，权限隔离通过启动时注入 bearer token 实现。CLI flag `--auth-token` 优先于环境变量。

```json
{
  "mcpServers": {
    "skill-mcp": {
      "command": "skill-mcp",
      "args": ["serve"],
      "env": { "SKILL_MCP_AUTH_TOKEN": "sk-live-xxxx" }
    }
  }
}
```

若数据库已存在 active 用户或带 tag 的 skill，但未配置 token，服务启动时会强制报错退出，避免静默匿名访问。空库或未启用权限的部署仍可匿名启动。

### Gateway HTTP 鉴权

`/api/gateway/*` 由鉴权中间件强制保护：每个请求必须携带 `Authorization: Bearer <token>`，缺失或无效 token 在 handler 之前直接返回 `401`。唯一的匿名端点是 `GET /api/health`（为负载均衡器 / 容器探针保留）。

```http
401 Unauthorized
Content-Type: application/json

{ "success": false, "error": "Authentication required" }
```

签发 token 的方式 —— 在服务端创建 role + user：

```bash
skill-mcp role create --name dev --tags "frontend"
skill-mcp user create --name alice --role-ids <role-id>
# → 打印 sk-live-xxxx；客户端发送 `Authorization: Bearer sk-live-xxxx`
```

对于 Proxy → Backend 内部调用，建议在 backend 侧创建一个专用 `svc-gateway` 用户，把 token 配到 proxy 侧的 `SKILL_MCP_AUTH_TOKEN` 环境变量。

`/mcp/*`（SSE / Streamable HTTP）及 stdio 传输不受影响 —— stdio 使用上文 `SKILL_MCP_AUTH_TOKEN` 启动期注入路径。

### JWT 管理员登录

管理员（admin/superadmin）通过用户名+密码登录获取 JWT token，用于 Web UI 管理操作。所有用户（包括管理员）同时拥有 opaque API token 用于 MCP 工具调用。

```bash
# 设置 JWT 密钥
export AUTH_JWT_SECRET=$(openssl rand -base64 32)

# 管理员登录
npx skill-mcp auth login --username admin

# 使用 JWT 访问管理 API
curl -H "Authorization: Bearer <access_token>" http://localhost:3000/api/admin/users

# 刷新 token
curl -X POST -H "Content-Type: application/json" \
  -d '{"refresh_token":"<refresh_token>"}' \
  http://localhost:3000/api/auth/refresh
```

**认证路径**：
- JWT（三段式 base64url）→ HMAC-SHA256 本地验证 → 管理员 session
- Opaque token → sha256 查表 → API token 认证（所有用户）

## 技能包格式

技能包是一个包含以下内容的目录：

```
my-skill/
├── SKILL.md          # 主要技能内容 + YAML frontmatter（必填）
├── references/       # 支持参考文件
│   └── examples.md
└── templates/        # 模板文件
    └── checklist.md
```

### SKILL.md frontmatter

技能元数据写在 `SKILL.md` 顶部的 YAML frontmatter 中：

```yaml
---
manifest_schema: "1.0"   # P1-21 — 见下方 "Manifest 版本契约"
name: my-skill
version: 0.0.1
description: 列表 API 展示的简短描述
entry: SKILL.md
files:
  - references/examples.md
tags: [writing, prompt]
category: writing
---

# 技能正文 markdown
```

### Manifest 版本契约（P1-21）

可选的 `manifest_schema` 字段声明该包遵循的契约版本。当前 schema 为 **`1.0`**。

| 客户端 `manifest_schema` | 本服务（1.x） | 未来服务（2.x） |
|--------------------------|---------------|------------------|
| 缺省 / `0.x`             | ✅ 自动当作 `1.0` 并输出 deprecated warning | ⚠️ 2.x 发布后可能拒绝 |
| `1.0`（任意 1.y）        | ✅ | ✅（向后兼容窗口：2 个 minor） |
| `2.0+`                   | ❌ "服务端版本过低，请升级" | ✅ |

可用内置 CLI 迁移历史包：

```bash
# Dry-run 扫描（默认）
skill-mcp manifest:migrate ./my-skills

# 直接改写 SKILL.md
skill-mcp manifest:migrate ./my-skills --apply

# 或输出 unified diff 走 code review / `git apply`
skill-mcp manifest:migrate ./my-skills --patch | git apply
```

> **遗留的 `manifest.json`** 已被弃用——遇到时 importer 会输出警告，并优先使用 `SKILL.md` frontmatter。schema 版本规则对两种载体一视同仁。

## 流程格式

流程是一个定义技能阶段 DAG（有向无环图）的 YAML 文件：

```yaml
name: code-review-pipeline
description: 带安全检查和风格检查的自动化代码审查

inputs:
  pr_url:
    type: string
    required: true

stages:
  read-pr:
    skill: github-pr-reader
    inputs:
      url: ${{ inputs.pr_url }}
    outputs: [diff, files]

  security-scan:
    skill: security-scanner
    depends_on: [read-pr]
    inputs:
      code: ${{ stages.read-pr.outputs.diff }}
    outputs: [vulnerabilities]

  style-check:
    skill: style-checker
    depends_on: [read-pr]
    inputs:
      files: ${{ stages.read-pr.outputs.files }}
    outputs: [violations]

  generate-report:
    skill: report-writer
    depends_on: [security-scan, style-check]
    inputs:
      security: ${{ stages.security-scan.outputs }}
      style: ${{ stages.style-check.outputs }}
    outputs: [report]

output:
  report: ${{ stages.generate-report.outputs.report }}
```

## 项目结构

```
src/
├── cli/              # CLI 命令（import, list, serve, pipeline, user, role 等）
├── config/           # 配置模式和加载器
├── mcp/              # MCP 服务器、工具和传输
│   ├── tools/        # MCP 工具实现
│   ├── transport/    # MCP 传输层（stdio、SSE、HTTP streamable）
│   └── prompt/       # 系统提示词构建器
├── services/         # 业务逻辑（skill 服务、访问日志、检索、webhook、用量）
├── provider/         # 数据提供者（local, remote）
├── pipeline/         # 流程引擎（DAG, executor, parser）
├── permission/       # 权限过滤器和 RBAC
├── storage/          # 存储提供者（local FS, aliyun OSS）
├── cache/            # 缓存提供者（memory LRU, file, composite）
├── db/               # 数据库模式、迁移、仓库
├── import/           # 技能导入流程（validator, sources）
├── http/             # HTTP 服务器、路由、中间件、处理器、OpenAPI
│   ├── handlers/     # 管理端处理器（skills/users/roles/webhooks/import-jobs）
│   ├── openapi/      # OpenAPI 3.1 规范和 Swagger UI
│   └── middleware/   # 认证、限流、request-id、错误映射
├── events/           # 事件系统（event bus, cache subscriber, webhook subscriber）
├── telemetry/        # Prometheus 指标和 OpenTelemetry 追踪
├── retrieval/        # 语义检索（BM25 索引、向量索引、混合评分器）
├── eval/             # 技能评估框架（echo/LLM 提供者、运行器）
├── types/            # TypeScript 类型定义
└── utils/            # 共享工具（security, errors, manifest, JWT）
```

## CLI 命令参考

| 命令 | 描述 |
|---------|-------------|
| `init` | 初始化系统，创建超级管理员账户（首次部署） |
| `auth login` | 管理员登录获取 JWT（支持 `--server-url` 远程模式） |
| `auth logout` | 清除本地 JWT 凭证 |
| `auth whoami` | 查看当前登录用户信息 |
| `auth reset-password` | 重置管理员密码（需要 admin+ 登录，支持远程模式） |
| `serve` | 启动 MCP 服务器 |
| `import <source>` | 从本地路径或 Git 仓库导入技能 |
| `list` | 列出所有技能 |
| `info <slug>` | 显示技能详情 |
| `search --name <name>` | 按名称搜索技能 |
| `update <slug>` | 更新技能元数据 |
| `remove <slug>` | 删除技能 |
| `versions <slug>` | 显示版本历史 |
| `rollback <slug>` | 回滚到之前的版本 |
| `lint <path>` | 检查技能包 |
| `manifest:migrate <dir>` | 扫描并迁移 `manifest_schema`（P1-21，支持 `--apply` / `--patch`）|
| `migrate:check` | 迁移预检：解析源/目标数据库 URL、检测 dialect 变更、列出 SQLite→PG 迁移惯用法 |
| `upgrade` | 检查 skill-mcp 在 npm 上是否有新版本 |
| `pipeline validate` | 验证流程 YAML |
| `pipeline graph` | 可视化流程 DAG |
| `pipeline run` | 执行流程 |
| `eval list` | 列出评估用例 |
| `eval run` | 运行评估用例 |
| `eval results` | 显示评估结果 |
| `user list/create/get/delete/assign-roles` | 管理用户（需要 admin+ 登录，支持远程模式） |
| `user create --username <u> --password <p> --user-type <type>` | 创建带登录凭据的用户（admin/superadmin 仅限 `--user-type admin`） |
| `role list/create/get/update/delete` | 管理角色（需要 admin+ 登录，支持远程模式） |
| `sync check [slug]` | 检查已导入技能的同步状态 |
| `sync pull <slug>` | 从远程源拉取最新版本 |
| `user rotate-token <userId>` | 轮换用户的 API token |

## 脚本

| 命令 | 描述 |
|---------|-------------|
| `npm run build` | 将 TypeScript 编译到 `dist/` |
| `npm run dev` | 监视模式编译 |
| `npm start` | 运行服务器 |
| `npm test` | 使用 Vitest 运行测试 |
| `npm run test:watch` | 以监视模式运行测试 |
| `npm run test:coverage` | 生成覆盖率报告 |
| `npm run lint` | 检查源文件 |
| `npm run lint:fix` | 检查并自动修复 |
| `npm run db:migrate` | 运行数据库迁移 |
| `npm run db:generate` | 生成 Drizzle 迁移文件 |
| `npm run db:studio` | 启动 Drizzle Studio UI |
| `npm run docs:sync` | 检查 README.md 同步状态 |
| `npm run serve` | 以 HTTP 模式启动服务器 |
| `npm run import` | 导入技能包 |
| `npm run list` | 列出所有已安装技能 |
| `npm run release:patch` | 升级补丁版本并创建标签 |
| `npm run release:minor` | 升级次版本并创建标签 |
| `npm run release:major` | 升级主版本并创建标签 |
| `npm run release:alpha` | 升级 alpha 预发布版本并创建标签 |
| `npm run release:beta` | 升级 beta 预发布版本并创建标签 |
| `npm run release:rc` | 升级 RC 预发布版本并创建标签 |
| `npm run release:dev` | 升级 dev 预发布版本并创建标签 |
| `npm run prepublishOnly` | 发布前构建检查 |

## 测试

测试使用 Vitest 编写，位于 `tests/` 中：

```
tests/
└── unit/
    ├── utils/           # 安全扫描、验证、错误处理
    ├── cache/           # LRU 缓存提供者
    ├── prompt/          # 系统提示词生成
    └── import/          # 包验证
```

```bash
# 运行所有测试
npm test

# 运行覆盖率
npm run test:coverage

# 监视模式
npm run test:watch
```

## RBAC 概述

服务器实现了两层权限系统：

### 用户类型（操作权限）

| 类型 | 登录方式 | 能力 |
|------|---------|------|
| `superadmin` | 用户名+密码 → JWT | 完全控制：管理用户、角色、技能。通过 `skill-mcp init` 创建，不可被其他用户修改。 |
| `admin` | 用户名+密码 → JWT | 管理技能、角色和普通用户。不能创建/修改管理员或超级管理员。 |
| `user` | 仅 API token（无登录） | 浏览已发布技能、使用 MCP 工具、提交反馈。无管理操作权限。 |

### 角色标签（数据可见性）

- **标签**：分配给技能的能力标签（`skills.tags`）
- **角色**：标签集合，控制用户对 private 技能的可见性
- **用户**：分配给角色以获得技能级访问控制

**可见性规则**：
- `skill.visibility = "public"` → 所有人可访问
- `skill.visibility = "private"` + `skill.tags ∩ user.tags ≠ ∅` → 用户拥有匹配标签时可访问
- `skill.visibility = "private"` + `skill.tags ∩ user.tags = ∅` → 不可访问

> **用户类型**控制**你能做什么**（操作权限）。**角色标签**控制**你能看什么**（数据可见性）。两者独立。

## CLI 远程模式

所有管理命令都支持通过 `--server-url` 或 `SKILL_MCP_SERVER_URL` 进行远程操作：

```bash
# 通过环境变量使用远程模式
export SKILL_MCP_SERVER_URL=http://server:3000
skill-mcp user list    # 调用 HTTP API
```

## 安全性

- **提示词注入扫描** — 所有导入的技能内容都会扫描已知的注入模式
- **路径遍历保护** — 文件路径验证防止目录遍历攻击
- **文件类型安全** — 拒绝二进制文件；仅允许基于文本的格式
- **按用户的 RBAC** — 管理员通过 JWT 登录（用户名+密码），普通用户通过 `skill-mcp user create` 颁发的 API token 鉴权。用户类型（`superadmin`/`admin`/`user`）决定操作权限；角色标签决定技能可见性。Service account 复用 user 表，命名约定为 `svc-*`。

## 许可证

MIT

---

# 📦 发布指南

## 发布流程

项目使用自动化流程进行发布，确保每次发布都经过完整的测试和验证。

### 流程概览

```
main 分支更新
    ↓
自动创建 Release PR
    ↓
审查并合并 Release PR
    ↓
自动创建 Git Tag
    ↓
触发发布 Workflow
    ↓
发布到 npm
    ↓
自动创建 GitHub Release
```

### 触发方式

#### 方式一：自动触发（推荐）

1. 将代码合并到 `main` 分支
2. GitHub Actions 自动创建 Release PR
3. 审查并合并 Release PR
4. 自动触发发布流程

#### 方式二：手动触发

1. 更新 `package.json` 中的版本号
2. 创建并推送 Git tag：
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
3. GitHub Actions 自动触发发布流程

#### 方式三：使用 npm scripts

```bash
# 发布补丁版本 (1.0.0 → 1.0.1)
npm run release:patch

# 发布次版本 (1.0.0 → 1.1.0)
npm run release:minor

# 发布主版本 (1.0.0 → 2.0.0)
npm run release:major

# 发布预发布版本
npm run release:alpha  # Alpha 测试版
npm run release:beta   # Beta 测试版
npm run release:rc     # RC 候选发布版
npm run release:dev    # Dev 开发版本
```

### 版本号规则

项目遵循 [Semantic Versioning](https://semver.org/) 规范：

- **主版本号 (MAJOR)**：不兼容的 API 变更
- **次版本号 (MINOR)**：向下兼容的功能新增
- **修订号 (PATCH)**：向下兼容的问题修正

### 版本类型与 npm 标签

| 版本类型 | Git Tag | npm dist-tag | GitHub Release |
|---------|----------|-------------|----------------|
| 正式版 | v1.0.0 | latest | 是 |
| RC 版 | v1.0.0-rc.1 | rc | 是 |
| Beta 版 | v1.0.0-beta.1 | beta | 否 |
| Alpha 版 | v1.0.0-alpha.1 | alpha | 否 |
| Dev 版 | v1.0.0-dev.1 | dev | 否 |

### 发布前检查

在发布前，请确保：

- [ ] 所有测试通过
- [ ] 代码已通过 ESLint 检查
- [ ] 文档已更新（README.md、README.zh.md）
- [ ] CHANGELOG.md 已更新
- [ ] 没有破坏性变更或已文档化

详细说明请参考 [发布指南](./docs/PUBLISHING.md)。

## GitHub Actions 工作流

### 1. CI Workflow (ci.yml)

在每个 PR 和 push 时运行，确保代码质量：

- 运行 ESLint
- TypeScript 编译
- 运行测试
- 生成覆盖率报告

### 2. Publish Workflow (publish.yml)

在创建 Git tag 时触发，执行发布：

- 运行完整的 CI 检查
- 验证版本号匹配
- 发布到 npm
- 创建 GitHub Release

### 3. Release PR Workflow (release-pr.yml)

在推送到 `main` 分支时自动创建 Release PR。

### 4. Create Tag Workflow (create-tag.yml)

在合并 Release PR 后自动创建 Git tag。

## 配置

### npm Token 配置

在 GitHub repository settings 中配置：

1. 进入 Settings → Secrets and variables → Actions
2. 添加新的 Secret：
   - Name: `NPM_TOKEN`
   - Value: Your npm automation token

### 获取 npm Token

1. 访问 https://www.npmjs.com/settings/tokens
2. 点击 "Create New Token"
3. 选择 "Automation" 类型
4. 复制生成的 token
5. 添加到 GitHub Secrets

## 发布后验证

发布完成后，验证以下内容：

1. **npm registry**
   - 访问 https://www.npmjs.com/package/skill-mcp-server
   - 确认版本号和发布时间正确

2. **GitHub Release**
   - 访问 repository 的 Releases 页面
   - 确认 Release 说明正确

3. **安装测试**
   ```bash
   npm install -g skill-mcp-server@<version>
   skill-mcp --help
   ```

## 回滚

如果发现问题需要回滚：

```bash
# 撤销 npm 发布（72 小时内）
npm unpublish skill-mcp-server@<version> --force

# 或发布新版本修复
npm run release:patch
```

**注意**：npm 只允许在发布后 72 小时内撤销，超过时间需要发布新版本修复。

## 故障排除

### 发布失败

检查以下内容：

1. npm token 是否正确配置
2. package.json 中的版本号是否与 tag 一致
3. CI 测试是否全部通过
4. 是否有文件冲突或权限问题

查看 GitHub Actions 日志获取详细错误信息。

### 版本号不匹配

错误信息：
```
❌ Version mismatch!
package.json version: 1.0.0
Git tag version: 1.0.1
```

解决方法：
- 更新 package.json 中的版本号
- 或删除并重新创建正确的 tag

### npm 认证失败

确保：
- npm token 使用 "Automation" 类型
- token 已添加到 GitHub Secrets
- token 没有过期

## 相关文档

- [Semantic Versioning](https://semver.org/)
- [npm publish](https://docs.npmjs.com/cli/v9/commands/npm-publish)
- [GitHub Actions](https://docs.github.com/en/actions)
