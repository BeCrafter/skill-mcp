# CLI 指南

`skill-mcp` 命令行的完整使用参考。涵盖技能导入、版本管理、用户/角色、服务部署与远程管理。

> 编译后通过 `node dist/index.js <cmd>` 或 `npx skill-mcp <cmd>` 执行。下文统一用 `skill-mcp`。

---

## 前置准备

```bash
npm run build                  # 编译到 dist/

# 初始化（首次使用必须）：创建超级管理员
skill-mcp init --username admin --password <password>
```

## 认证

| 模式 | 认证方式 | 环境变量 |
|------|---------|---------|
| 本地 CLI | `~/.skill-mcp/credentials.json`（`auth login` 写入） | — |
| stdio MCP | `--auth-token` 或 `SKILL_MCP_AUTH_TOKEN` | `SKILL_MCP_AUTH_TOKEN` |
| HTTP/SSE MCP | 请求头 `Authorization: Bearer <token>` | — |
| CLI 远程管理 | `--server-url`（JWT） | `SKILL_MCP_SERVER_URL` |

```bash
# 本地登录（操作本地 DB）
skill-mcp auth login

# 远程登录（操作远端 Registry）
skill-mcp auth login --server-url http://localhost:3000
```

JWT token 也通过 API 获取：`POST /api/auth/login` 的 `access_token`。

---

## 1. 技能导入 `import`

```bash
skill-mcp import ./my-skill                       # 本地目录
skill-mcp import https://github.com/user/repo     # Git 仓库
skill-mcp import ./my-skill --overwrite           # 覆盖同名
skill-mcp import ./my-skill --allow-duplicate     # 允许重复（不同 slug）
skill-mcp import ./my-skill --slug my-custom      # 指定 slug
skill-mcp import ./my-skill --category writing --tags prompt,ai
skill-mcp import ./my-skill --description "..." --version-bump minor
skill-mcp import https://github.com/u/r --branch main --sub-dir skills/x
skill-mcp import ./my-skill --id <skill-id>       # 覆盖更新指定技能
```

导入是**同步**的。经运行中的 `serve`（HTTP 导入路径）导入时，成功返回前会等待对应 Skill 的 BM25 索引刷新（v0.1 搜索契约 #2）；本地 CLI `import` 命令不持有内存索引，刷新在下次 `serve` 启动水合时生效。

## 2. 列表 `list` / 搜索 `search` / 详情 `info`

```bash
skill-mcp list
skill-mcp list --tags prompt
skill-mcp list --name prompt

skill-mcp search --name prompt       # 按名称/描述搜索
skill-mcp search --name code

skill-mcp info prompt-writer          # 查看元数据
```

`⎇` 标记表示 Git 远程导入的技能。

## 3. 更新 `update`

```bash
skill-mcp update prompt-writer --category ai-writing
skill-mcp update prompt-writer --tags prompt,ai
skill-mcp update prompt-writer --description "..."
skill-mcp update prompt-writer --display-name "Prompt Writer Pro"
```

> 元数据更新（内容未变）经运行中的 `serve` 也会在返回前等待索引刷新，确保 `description`/`tags` 立即可检索/按可见性过滤；本地 CLI `update` 不持有内存索引。

## 4. 版本管理 `versions` / 回滚 `rollback`

```bash
skill-mcp versions prompt-writer                       # 版本列表
skill-mcp versions prompt-writer --show 1.1.0          # 查看某版本
skill-mcp versions prompt-writer --diff 1.0.0..1.2.0   # 版本对比

skill-mcp rollback prompt-writer --to 1.0.0            # 回滚
```

## 5. 删除 `remove`

```bash
skill-mcp remove prompt-writer        # 交互确认
skill-mcp remove prompt-writer --force
```

## 6. 同步 `sync`

```bash
skill-mcp sync check prompt-writer    # 检查单个远程技能是否有更新
skill-mcp sync check --all             # 检查所有
skill-mcp sync pull prompt-writer      # 拉取更新
```

## 7. 质量检查 `lint`

```bash
skill-mcp lint ./my-skill             # 校验 Skill 包（不导入）
skill-mcp manifest:migrate ./my-skill # 迁移到最新 manifest 规范
```

## 8. 用户与角色

```bash
skill-mcp user create --name alice --role-ids <id>
skill-mcp user list
skill-mcp user get <id>
skill-mcp user delete <id>
skill-mcp user assign-roles <id> --role-ids <id>,<id>
skill-mcp user rotate-token <id>

skill-mcp role create --name reader --tags skill:read
skill-mcp role list
skill-mcp role get <id>
skill-mcp role update <id> --tags skill:read,skill:write
skill-mcp role delete <id>
```

权限矩阵与角色边界见 [权限管控](../permission-control.md)。

---

## 9. 启动服务 `serve`

```bash
skill-mcp serve                                       # 默认 stdio
skill-mcp serve --transport http --port 3000          # HTTP（C1）
skill-mcp serve --transport http --mcp-only           # 仅 MCP（C2 的 mcp 节点）
skill-mcp serve --transport http --api-only           # 仅 REST（C2 的 storage / 后端）
```

| 选项 | 说明 |
|------|------|
| `--transport <stdio\|sse\|http>` | 传输方式（默认 stdio） |
| `--port <number>` | HTTP/SSE 端口 |
| `--mcp-only` | 仅暴露 MCP + health（与 `--api-only` 互斥） |
| `--api-only` | 仅暴露 REST + health |
| `--auth-token <token>` | stdio bearer token（覆盖 `SKILL_MCP_AUTH_TOKEN`） |

### C2 代理模式（v0.1 语义）

`serve` **不接受** `--remote-url`。代理模式通过环境变量 `CLOUD_SERVICE_URL` 触发：

```bash
# storage（权威库）
skill-mcp serve --transport http --port 3000 --api-only --auth-token <token>

# mcp 代理节点
CLOUD_SERVICE_URL=http://storage:3000 SKILL_MCP_AUTH_TOKEN=<token> \
  skill-mcp serve --transport http --port 4000 --mcp-only
```

- 代理节点用 `RemoteSkillProvider` 转发 skill 读写到 storage。
- `skill_search` 委派到 storage 的 `/api/gateway/skills/search`，BM25 + RBAC 由 storage 侧完成（保留 v0.1 搜索契约）。
- 代理节点跳过本地 BM25 水合（索引归 storage）。
- MCP 工具共 5 个：`skill_list`、`skill_search`、`skill_view`、`skill_file`、`skill_feedback`。

部署细节见 [部署文档](../deployment/README.md)。

---

## 10. 远程管理

`--server-url` 指向另一台独立的 v0.1 Registry，仅用于 **CLI 管理**（不解释为服务端代理）：

```bash
export SKILL_MCP_SERVER_URL=http://localhost:3000
skill-mcp list
skill-mcp import ./my-skill
skill-mcp user create --name alice --role-ids <id>
```

---

## 环境变量参考

| 变量 | 说明 | 默认 |
|------|------|------|
| `DATABASE_PATH` | SQLite 文件路径 | `~/.skill-mcp/skill-mcp.db` |
| `STORAGE_BASE_PATH` | Skill 文件目录 | `~/.skill-mcp/data/skills` |
| `TRANSPORT_TYPE` | `stdio` / `sse` / `http` | `stdio` |
| `TRANSPORT_PORT` | HTTP/SSE 端口 | `3000` |
| `CLOUD_SERVICE_URL` | C2 代理模式（指向 storage） | （本地模式） |
| `MCP_ONLY_MODE` | 仅 MCP + health | `false` |
| `API_ONLY_MODE` | 仅 REST + health | `false` |
| `SKILL_MCP_AUTH_TOKEN` | Bearer token（MCP 认证 / 代理出站） | — |
| `SKILL_MCP_SERVER_URL` | CLI 远程管理 URL | （本地 DB） |
| `AUTH_JWT_SECRET` | JWT 密钥（≥32 字符） | 自动生成 |
| `SECURITY_INJECTION_SCAN` | Prompt injection 检测 | `true` |
| `LOG_LEVEL` | `trace`/`debug`/`info`/`warn`/`error` | `info` |

完整带注释列表见 [`.env.example`](../../.env.example)。

---

## 故障排查

### 数据库未初始化
```
Error: no such table: skills
```
→ `skill-mcp init --username admin --password <password>`

### 未登录
```
Error: Not logged in. Run `skill-mcp auth login` first.
```
→ `skill-mcp auth login`（远程加 `--server-url`）

### 技能已存在
```
Error: Skill "my-skill" already exists
```
→ `--overwrite` 覆盖，或 `--allow-duplicate` 允许重复。

### 版本不存在
```
Error: Version v2.0.0 not found
```
→ `skill-mcp versions <slug>` 查看可用版本。

### 相关文档

- [部署文档](../deployment/README.md)
- [权限管控](../permission-control.md)
- [v0.1 发布范围](../releases/v0.1.md)
