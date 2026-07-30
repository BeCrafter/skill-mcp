# 部署：单机 HTTP（C1）

单一 HTTP 进程同时承载 MCP、Admin/Gateway REST、SQLite 与 local-fs。适合开发/测试与小规模独立部署。

## 架构

```
多个客户端 ↔ [HTTP / SSE / Streamable] ↔ skill-mcp (单进程) ↔ local SQLite + local-fs
```

## 部署

```bash
npx skill-mcp serve --transport http --port 3000
```

或用 Docker：

```bash
docker compose --profile c1 up -d --build
curl http://localhost:3000/api/health
```

如需 HTTPS 网关：

```bash
DOMAIN=your-domain.com docker compose --profile c1-gateway up -d --build
```

## 客户端连接

在 Claude IDE / MCP 客户端中配置：

```json
{
  "mcpServers": {
    "skill-mcp": {
      "url": "http://localhost:3000/mcp",
      "transport": "http"
    }
  }
}
```

SSE 端点 `http://localhost:3000/mcp/sse` 仅在 `--transport sse` 时注册；`--transport http` 仅暴露 Streamable HTTP `/mcp`。

## 性能特性

- 多个并发连接共享 L1 内存缓存
- 会话隔离，缓存跨会话共享
- 适合约 1–10 个并发客户端；更高并发请用 [C2 分布式](./distributed-c2.md)

## 监控

```bash
curl http://localhost:3000/api/health     # 健康检查（无鉴权，供 LB/容器探针）
curl http://localhost:3000/metrics         # Prometheus 指标（需鉴权）
```

## 相关

- [C2 分布式部署](./distributed-c2.md)
- [API-only 后端](./api-only-backend.md)
- [Docker 配置](../../docker/README.md)
