# 部署

skill-mcp v0.1 的部署形态。所有形态均为本地 SQLite + local-fs，单进程不可横向扩展同一个 SQLite 实例。

## 选型

| 形态 | 命令 | 适用 | 文档 |
|------|------|------|------|
| **本地 stdio** | `npx skill-mcp serve` | 个人 IDE / Agent，无需网络 | [local-stdio.md](./local-stdio.md) |
| **单机 HTTP（C1）** | `serve --transport http` | 开发/测试，1–10 并发 | [single-http.md](./single-http.md) |
| **分布式（C2）** | `--profile c2` | 生产，多 MCP 节点 + 权威 storage | [distributed-c2.md](./distributed-c2.md) |
| **API-only 后端** | `serve --api-only` | REST 管理自动化 / 作为 C2 的 storage | [api-only-backend.md](./api-only-backend.md) |

> v0.1 不支持：向量/embedding 检索、Eval、Pipeline、Webhook、OSS、PostgreSQL、OpenTelemetry、自升级、异步导入。远程代理能力（`CLOUD_SERVICE_URL` + `RemoteSkillProvider`）在 C2 中支持。

## 模式开关

| 标志 / 环境变量 | 作用 |
|------|------|
| `MCP_ONLY_MODE=true` / `--mcp-only` | 仅暴露 MCP + health（C2 的 mcp 节点） |
| `API_ONLY_MODE=true` / `--api-only` | 仅暴露 REST + health（C2 的 storage / 后端） |
| `CLOUD_SERVICE_URL=<url>` | 启用 C2 代理模式（`RemoteSkillProvider` 代理到 storage） |
| `SKILL_MCP_AUTH_TOKEN=<token>` | Bearer token（MCP 认证 / 代理出站） |

`--mcp-only` 与 `--api-only` 互斥。

## C1 vs C2 如何选

- **C1**：开发/测试；并发 < 20；无需高可用；一个进程管全部。
- **C2**：生产；并发 > 20；需要高可用与可扩展；接受多组件运维。

## 进一步

- [Docker 配置](../../docker/README.md) — Dockerfile、Compose、Caddyfile
- [权限管控](../permission-control.md) — RBAC 矩阵与服务账号
- [v0.1 发布范围](../releases/v0.1.md) — 能力边界契约
