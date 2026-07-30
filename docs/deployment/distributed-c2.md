# 部署：分布式 C2（storage + MCP 代理 + 网关）

C2 把权威数据层（storage，API-only）与 MCP 前端（mcp1/mcp2，MCP-only + `RemoteSkillProvider`）分离，前置 Caddy 做负载均衡与自动 HTTPS。适合生产与高并发。

## 架构

```
        客户端
          │ (HTTPS)
   ┌──────▼─────── Caddy 网关 ──────────┐
   │ /mcp*           → mcp1:4000 mcp2:4000 (负载均衡)
   │ /api/gateway/*  → storage:3000
   │ /api/health     → storage:3000
   └──┬───────────────┬───────────────┐
      ▼               ▼               ▼
   mcp1:4000      mcp2:4000      ...（MCP-only，代理到 storage）
      └───────────────┴──── CLOUD_SERVICE_URL ──→ storage:3000
                                              (API-only，权威 SQLite + local-fs + BM25 索引)
```

- **storage**：权威数据源，持有 SQLite + local-fs + 本地 BM25 索引，负责 RBAC 与搜索评分。
- **mcp1/mcp2**：MCP-only，通过 `RemoteSkillProvider` 代理 skill 读写；`skill_search` 委派到 storage 的 `/api/gateway/skills/search`，BM25 由 storage 评分（保留 v0.1 搜索契约）。
- **Caddy**：自动 HTTPS、MCP 端点负载均衡、gateway API 透传认证头。
  > ⚠️ 运行时注记：Caddyfile 用 `header_up Authorization {>Authorization}` 透传 `Authorization` 头，但在当前 Caddy v2 该方式转发不稳定（见 `docker/verify.sh` 注释）。生产应直接在网络内调用 storage 的 `/api/gateway/*`，或改用 Caddy `request_header` / 命名上游与 `copy_headers` 等更可靠方式验证。

## 部署

### 1. storage（API-only 权威库）

```bash
npx skill-mcp serve --transport http --port 3000 --api-only --auth-token <service-token>
```

### 2. MCP 代理节点（可多个）

```bash
CLOUD_SERVICE_URL=http://storage:3000 \
SKILL_MCP_AUTH_TOKEN=<service-token> \
npx skill-mcp serve --transport http --port 4000 --mcp-only
```

启动日志应出现 `C2 proxy mode — fronting remote storage Registry`。

### 3. Docker Compose（推荐）

```bash
export STORAGE_SVC_TOKEN=<service-token>
docker compose --profile c2 up -d --build

# 验证（storage 在 c2 中为内部网络，无主机端口；mcp1/mcp2 发布在 4001/4002）
docker compose --profile c2 exec storage curl -s http://localhost:3000/api/health
curl http://localhost:4001/api/health
```

带 HTTPS 网关：

```bash
DOMAIN=your-domain.com ACME_EMAIL=admin@example.com \
  docker compose --profile c2 --profile gateway up -d --build
```

详见 [docker/README.md](../../docker/README.md)。

## RBAC 与服务账号

```bash
# 在 storage 上创建角色与服务账号
skill-mcp role create --name gateway --tags skill:read
skill-mcp user create --name svc-gateway --role-ids <role-id>
# 输出的 token 作为 mcp 节点的 SKILL_MCP_AUTH_TOKEN
```

> C2 限制：mcp1/mcp2 以服务账号身份访问 storage，所有 MCP 客户端共享该服务账号的 RBAC 视图（不做逐终端用户转发）。这是已知取舍。

## 监控

storage 指标（c2 中 storage 为内部网络，需 `docker compose exec`；`/metrics` 需 admin 鉴权或 `SKILL_MCP_METRICS_AUTH_OPTIONAL=true`）：

```bash
docker compose --profile c2 exec storage curl -s -H "Authorization: Bearer <admin-token>" http://localhost:3000/metrics
```

> mcp1/mcp2 为 `MCP_ONLY_MODE`，仅暴露 `/api/health` 与 `/mcp`，**不提供 `/metrics` 端点**。

关键指标：`skill_mcp_tool_calls_total`、`skill_mcp_cache_operations_total`、`skill_mcp_remote_validation_errors_total`（代理 schema 校验失败）、`skill_mcp_rate_limit_denied_total`。

## 扩缩容

C2 默认启动 mcp1 + mcp2。增加实例：在 `docker/docker-compose.yml` 复制 `mcp2` 为 `mcp3`（含 `MCP_ONLY_MODE`+`CLOUD_SERVICE_URL`），并更新 `start.sh` 的 `gateway` 案例中 `MCP_BACKEND` 环境变量（Caddyfile 通过 `{$MCP_BACKEND}` 读取该变量，**无需改 Caddyfile**）。

storage 层不可水平扩展同一个 SQLite 实例；如需更高吞吐，部署独立的 storage Registry 并前置负载均衡。

## 生产运维

### 备份

镜像仅含 `curl`（无 `sqlite3`），DB 实际在 `/app/data/skill-mcp.db`。用 `docker cp` 导出后在宿主机操作：

```bash
docker compose --profile c2 cp storage:/app/data/skill-mcp.db ./backup-$(date +%F).db
docker compose --profile c2 cp storage:/app/data/skills ./skills-backup
tar czf skills-backup.tar.gz skills-backup
```

### 滚动更新

```bash
docker compose --profile c2 up -d --no-deps storage   # 先更新 storage
sleep 30
docker compose --profile c2 up -d --no-deps mcp1 mcp2
```

### 故障排查

```bash
docker compose --profile c2 logs storage              # storage 日志
docker compose --profile c2 logs mcp1                  # 代理日志
docker compose --profile c2 exec mcp1 rm -rf /app/data/cache/*   # 清缓存
docker compose --profile c2 exec storage curl -s http://localhost:3000/api/health   # 健康检查
```

storage 宕机时：mcp 节点本地缓存 TTL 内仍可读，新查询失败；重启 storage 后自动重连。

## 相关

- [单机 HTTP（C1）](./single-http.md)
- [API-only 后端](./api-only-backend.md)
- [Docker 配置](../../docker/README.md)
