# Skill MCP Server

**基于本地 SQLite 的权限化 Skill Registry，提供 BM25 检索与 MCP 多传输。**

一个管理 AI 助手可复用 Skill 包的 MCP（Model Context Protocol）服务器。
通过标准 MCP 工具导入、版本化并提供 Skill 包，内置安全扫描与基于角色的访问控制。

## 核心特性

- **MCP 协议** — 5 个工具：`skill_list`、`skill_search`、`skill_view`、`skill_file`、`skill_feedback`
- **多传输** — 支持 stdio、SSE 和 Streamable HTTP 传输
- **BM25 搜索** — 内存关键词搜索覆盖名称、描述、`triggers`、`when_to_use` 和
  `embedding_text`。RBAC 可见性过滤**先于** BM25 评分与截断。
- **三级 RBAC** — Superadmin / Admin / User，基于角色的 tag 权限
- **JWT 认证** — 用户名 + 密码登录，JWT access/refresh token
- **Skill 导入** — 从本地目录或 Git 仓库同步导入 Skill 包
- **安全扫描** — 对所有导入内容进行内置 prompt injection 检测
- **版本管理** — 自动语义化版本、内容哈希追踪与回滚支持
- **分层缓存** — 内存（LRU）+ 文件双层缓存，加速 Skill 检索
- **SQLite 存储** — Drizzle ORM + better-sqlite3 持久化元数据；local-fs 存储 Skill 文件
- **OpenAPI & Swagger** — HTTP 模式内置 `/api/docs` API 文档
- **审计日志** — 自动追踪 Skill 变更，记录前后快照
- **Prometheus 指标** — `/metrics` 端点，含导入、缓存、限流、权限计数
- **CLI 管理** — 完整命令行：导入、列出、搜索、管理 Skill 及用户/角色
- **C2 远程代理** — 设置 `CLOUD_SERVICE_URL` 后，`serve` 通过 `RemoteSkillProvider`
  代理到远程 storage Registry；`skill_search` 委派到远端 BM25 索引。
  通过 `docker compose --profile c2` 部署。

## 快速开始

```bash
npx skill-mcp init --username admin --password <password>   # 打印 bearer token
npx skill-mcp import ./my-skill/
npx skill-mcp serve --auth-token <token>   # stdio 模式在 init 后需要认证
```

服务以 stdio 模式启动，接受 MCP 连接。HTTP 模式：

```bash
npx skill-mcp serve --transport http --port 3000
```

打开 `http://localhost:3000/api/docs` 查看 Swagger UI。

## MCP 工具

| 工具 | 说明 |
| --- | --- |
| `skill_list` | 列出当前用户有权访问的 Skill（RBAC 过滤） |
| `skill_search` | BM25 关键词搜索，权限感知排序 |
| `skill_view` | 获取 Skill 入口文件（SKILL.md） |
| `skill_file` | 读取 Skill 中的一个或多个文件 |
| `skill_feedback` | 记录 Skill 使用反馈 |

## CLI 命令参考

| 命令 | 说明 |
| --- | --- |
| `init` | 初始化数据目录和配置 |
| `serve` | 启动 MCP 服务器（默认 stdio） |
| `import <source>` | 从本地目录或 Git URL 导入 Skill |
| `list` | 列出已安装的 Skill |
| `search --name <name>` | 按名称搜索 Skill |
| `info <slug>` | 查看 Skill 元数据 |
| `remove <slug>` | 删除 Skill |
| `update <slug>` | 更新 Skill 元数据 |
| `versions <slug>` | 查看 Skill 版本列表 |
| `rollback <slug>` | 回滚到历史版本 |
| `sync check [slug]` | 检查远程更新 |
| `sync pull <slug>` | 拉取远程 Skill 更新 |
| `lint <source>` | 校验 Skill 包（不导入） |
| `manifest:migrate <dir>` | 将 Skill 目录迁移到最新 manifest 规范 |
| `user create/list/get/delete/assign-roles/rotate-token` | 用户管理 |
| `role create/list/get/update/delete` | 角色与 tag 管理 |
| `auth (login/logout/whoami/reset-password)` | 认证管理 |

使用 `--server-url <url>` 将 CLI 命令指向远程 v0.1 Registry（而非本地 DB）。

## 环境变量

完整带注释列表见 `.env.example`。

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `DATABASE_PATH` | SQLite 数据库文件路径 | `~/.skill-mcp/skill-mcp.db` |
| `STORAGE_BASE_PATH` | Skill 文件存储目录 | `~/.skill-mcp/data/skills` |
| `TRANSPORT_TYPE` | MCP 传输：`stdio`、`sse`、`http` | `stdio` |
| `TRANSPORT_PORT` | HTTP/SSE 端口 | `3000` |
| `CLOUD_SERVICE_URL` | 启用 C2 远程代理模式（前端代理到远程 Registry） | （本地模式） |
| `MCP_ONLY_MODE` | 仅暴露 MCP + health 端点 | `false` |
| `API_ONLY_MODE` | 仅暴露 REST API + health 端点 | `false` |
| `SKILL_MCP_AUTH_TOKEN` | MCP 认证 / 远程代理认证的 Bearer token | — |
| `SKILL_MCP_SERVER_URL` | CLI 管理的远程 Registry 地址 | （本地 DB） |
| `AUTH_JWT_SECRET` | JWT 签名密钥（最少 32 字符） | 自动生成 |
| `SECURITY_INJECTION_SCAN` | 启用 Prompt Injection 检测 | `true` |
| `LOG_LEVEL` | 日志级别：`trace`、`debug`、`info`、`warn`、`error` | `info` |

## 部署场景

**场景 A — 本地 stdio**（个人 IDE / Agent）
```
TRANSPORT_TYPE=stdio  DATABASE_PATH=./data/skill-mcp.db  STORAGE_BASE_PATH=./data/skills
```

**场景 C1 — 单机 HTTP**（一体化）
```
TRANSPORT_TYPE=http  TRANSPORT_PORT=3000
```
`docker compose --profile c1 up -d`

**场景 C2 — 分布式代理**（storage 权威库 + MCP 前端节点 + Caddy 网关）
```
# Storage（权威数据）
TRANSPORT_TYPE=http  TRANSPORT_PORT=3000  API_ONLY_MODE=true
SKILL_MCP_AUTH_TOKEN=<共享 token>

# MCP 节点（代理前端）
TRANSPORT_TYPE=http  TRANSPORT_PORT=4000  MCP_ONLY_MODE=true
CLOUD_SERVICE_URL=http://storage:3000  SKILL_MCP_AUTH_TOKEN=<共享 token>
```
`docker compose --profile c2 up -d`

## 项目结构

```
src/
├── cli/          CLI 命令
├── config/       配置加载与 zod 校验
├── cache/        L1（内存）/ L2（文件）缓存
├── db/           Drizzle schema、迁移、Repository
├── events/       领域事件总线与缓存订阅
├── http/         处理器、中间件、路由、OpenAPI 规范
├── import/       Skill 导入器（本地 + Git 源）
├── mcp/          MCP 工具、服务器、传输、提示词
├── permission/   RBAC tag 过滤器、上下文构建器
├── provider/     ISkillProvider：本地 + 远程实现
├── retrieval/    BM25 内存索引
├── services/     SkillService、SkillSearchService、AccessLogService
├── storage/      LocalFileSystemProvider
├── telemetry/    Prometheus 指标
├── types/        共享 TypeScript 接口
└── utils/        Manifest 解析、安全、日志、错误
```

## 开发

```bash
npm install
npm run build
npm run lint
npm test
npm run docs:sync
```

保持 `README.md`、`README.zh.md` 和 `docs/releases/v0.1.md` 与 v0.1 公共契约对齐。
不提交生成的 `dist/`、本地数据或密钥。

## 文档

完整文档位于 [`docs/`](./docs/README.md) — 见 [文档索引](./docs/README.md)（CLI 指南、部署形态、权限管控、v0.1 范围契约）。

## License

MIT
