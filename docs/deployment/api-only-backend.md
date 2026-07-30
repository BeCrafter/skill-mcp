# Scenario B（API-only 远端 + CLI 本地管理）

API-only Remote Registry — REST management without a local MCP.

## 概述

Scenario B 适用于：
- 需要一个远端 Registry 作为权威数据源（Skill 存储+REST 管理）。
- 本地开发机能通过 `--server-url` CLI 管理远端，而不在每个本地 Registry 上重复执行 import。
- 远端只暴露 REST API（`API_ONLY_MODE=true`），不直接提供 MCP 连接。

## 架构

```
Local CLI → [HTTP] → Remote Registry (API-only) → local SQLite + local-fs
```

远端 Registry 自带 BM25 索引、RBAC、导入与版本回滚。本地 CLI 命令通过 `--server-url` 把管理操作（import、list、user create 等）发到远端 HTTP API。

## 部署步骤

### 1. 启动远端 Registry

```bash
npx skill-mcp serve --transport http --port 3000 --api-only --auth-token my-token
```

或在 Docker：
```bash
docker compose --profile backend up -d
```

验证：
```bash
curl http://localhost:3001/api/health
```

### 2. 从本地管理远端 Registry

```bash
# 登录（JWT 认证）
skill-mcp auth login --server-url http://localhost:3001

# 导入 Skill
skill-mcp import ./my-skill --server-url http://localhost:3001

# 列出远端 Skill
skill-mcp list --server-url http://localhost:3001
```

等价地：持久化环境变量 `SKILL_MCP_SERVER_URL=http://localhost:3001` 即可省略每次的 `--server-url`。

> 注意：`--server-url` 只用于 **CLI 管理**。`serve` 时不接受 `--remote-url`（C2 服务端代理仅由 `CLOUD_SERVICE_URL` 触发，`MCP_ONLY_MODE` 是独立的路由限制开关；见 [分布式 C2](./distributed-c2.md)）。

## 环境变量

| 变量 | 用途 | 说明 |
|------|------|------|
| `API_ONLY_MODE=true` | 仅暴露 REST + health 端点 | 远端 Registry |
| `SKILL_MCP_AUTH_TOKEN` | Bearer token（REST auth） | — |
| `SKILL_MCP_SERVER_URL` | CLI 远端 URL | 本地管理 |
| `STORAGE_TYPE=local-fs` | v0.1：仅支持 local-fs | — |

## 下一步

- [分布式 C2 部署](./distributed-c2.md)
- [Docker 配置](../../docker/README.md)
