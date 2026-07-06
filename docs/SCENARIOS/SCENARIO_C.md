# 场景 C：分布式部署模式

HTTP MCP + 可选远程存储

## 概述

场景 C 有两种部署方式：

- **C1：单体部署** - 单一 HTTP 服务器同时提供 MCP 和存储
- **C2：分离部署** - MCP 层和存储层分离（推荐生产）

## 场景 C1：单体 HTTP 部署

### 适用场景

- 中等规模部署
- 对延迟要求不高
- 不需要水平扩展

### 架构

```
多个客户端 ↔ [HTTP/SSE] ↔ MCP Server ↔ LocalFS + SQLite
```

### 部署步骤

```bash
# 1. 创建配置文件
cp src/config/examples/.env.scenario-c1 .env

# 2. 启动服务
npm start

# 日志输出：
# [INFO] Streamable HTTP transport configured at /mcp
# [INFO] Server listening on http://0.0.0.0:3000
```

### 客户端连接

在 Claude IDE 中配置：

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

### 性能特性

- 多个并发连接共享 L1 内存缓存
- 会话隔离但缓存共享
- 适合 1-10 个并发客户端

### 监控

```bash
# 检查连接状态
curl http://localhost:3000/api/health

# 查看 Prometheus 指标
curl http://localhost:3000/metrics
```

## 场景 C2：分离部署（推荐生产）

### 优势

- **可扩展性** - 独立扩展 MCP 和存储层
- **高可用性** - 存储服务单点保护，MCP 无状态
- **易维护** - 职责清晰，独立更新
- **性能** - 可使用 OSS 等高性能存储

### 架构

```
多个客户端 ↔ [HTTP/SSE] ↔ MCP(1,2,3...) ↔ [HTTP] ↔ Storage ↔ OSS
```

### 部署步骤

#### 1. 部署存储服务

```bash
# 在存储服务器上
cp src/config/examples/.env.scenario-c2-storage .env

# 编辑配置（可选）
# - 修改 STORAGE_TYPE (local-fs 或 aliyun-oss)
# - 创建用户和角色以控制访问（见下方说明）

# 启动
npm start

# 验证
curl http://localhost:3000/api/gateway/health
```

#### 2. 部署 MCP 通道

```bash
# 在 MCP 服务器上（可以是多个）
cp src/config/examples/.env.scenario-c2-mcp .env

# 编辑配置
# - 修改 CLOUD_SERVICE_URL 为存储服务器地址
# - 修改 AUTH_TOKEN 为服务账号 Bearer Token

# 启动
npm start

# 验证（显示多条 MCP 启动日志表示成功）
# [INFO] HTTP transport configured at port 4000
# [INFO] RemoteSkillProvider initialized
```

#### 3. 配置负载均衡（可选）

```Caddyfile
# docker/Caddyfile
your-domain.com {
    # MCP 端点
    handle /mcp* {
        reverse_proxy mcp:4000
    }

    # Gateway API
    handle /api/gateway/* {
        reverse_proxy storage:3000
    }
}
```

## Docker Compose 部署

项目使用统一的 `docker-compose.yml`，支持多种部署场景：

### C1：单体部署

```bash
# 构建并启动
docker compose --profile c1 up -d --build

# 验证
curl http://localhost:3000/api/health
```

### C2：分离部署

```bash
# 1. 创建服务账号
export STORAGE_SVC_TOKEN=$(skill-mcp user create svc-gateway --role <role-id> | grep -oP 'token: \K.*')

# 2. 启动服务
docker compose --profile c2 up -d --build

# 3. 验证
curl http://localhost:3000/api/gateway/health
```

### 带 HTTPS 网关

```bash
# 1. 设置环境变量
export DOMAIN=your-domain.com
export ACME_EMAIL=admin@example.com
export STORAGE_SVC_TOKEN=<your-token>

# 2. 启动服务（自动获取 HTTPS 证书）
docker compose --profile c2 --profile gateway up -d

# 3. 访问
https://your-domain.com/mcp
```

详细配置见 `docker/README.md`。

## 生产配置建议

### 存储层

```bash
# 使用阿里云 OSS
STORAGE_TYPE=aliyun-oss
STORAGE_BUCKET=skill-bucket
STORAGE_REGION=oss-cn-beijing
STORAGE_ACCESS_KEY_ID=xxx
STORAGE_ACCESS_KEY_SECRET=xxx

# 配置 RBAC 认证
# 1. 创建角色：skill-mcp role create --name gateway --tags "skill:read"
# 2. 创建服务账号：skill-mcp user create --name svc-gateway --role-ids <role-id>
# 客户端使用输出的 JWT token 作为 AUTH_TOKEN
```

### MCP 层

```bash
# 多实例配置
MCP_ONLY_MODE=true

# 使用服务账号 token
AUTH_TOKEN=<jwt-token-from-user-create>

# 增加缓存
CACHE_MEMORY_MAX_SIZE=1000
CACHE_FILE_ENABLED=true
```

### 监控和告警

```yaml
# 关键指标
- API 响应时间 (p95 < 1s)
- 缓存命中率 (目标 > 80%)
- 错误率 (目标 < 0.1%)
- 存储延迟 (p95 < 200ms)
- 认证失败次数 (< 10/min)
```

## 会话管理

### SSE 会话

SSE 连接通过 sessionId 管理：

```typescript
// 客户端获取 sessionId
GET /mcp/sse
// 返回响应头中的 sessionId

// 客户端发送消息
POST /mcp/messages?sessionId=xxx
// 使用 sessionId 路由到正确的会话
```

### HTTP 流式会话

Streamable HTTP 自动管理会话，MCP SDK 透明处理。

### 会话隔离

- 每个连接的会话完全隔离
- 一个会话中的错误不影响其他会话
- 缓存在会话间共享（数据一致）

## 扩展性分析

### C1 单体部署扩展性

| 并发数 | L1 缓存 | 性能 | 磁盘 I/O |
|--------|--------|------|---------|
| 1-5 | 充足 | 最优 | 低 |
| 5-20 | 适当 | 良好 | 中 |
| 20-50 | 不足 | 降低 | 高 |
| >50 | 溢出 | 不可用 | 极高 |

**建议**：单体模式适合 ≤ 20 并发客户端

### C2 分离部署扩展性

| 组件 | 扩展方法 | 性能提升 |
|------|---------|---------|
| MCP 层 | 增加实例 + 负载均衡 | 线性 |
| 存储层 | 使用 OSS | 10-100 倍 |
| 缓存 | L1 + 本地 L2 | 3-5 倍 |

**建议**：分离模式可扩展到数百并发客户端

## 故障处理

### 存储服务宕机

**C1 影响**：所有客户端无法访问

**C2 影响**：MCP 层缓存仍可用，新查询失败

恢复：
```bash
# 1. 重启存储服务
docker-compose -f docker/docker-compose.c2.yml up -d storage

# 2. MCP 会自动重连
# 3. 清除过期缓存
docker-compose -f docker/docker-compose.c2.yml exec mcp-1 \
  rm -rf /app/data/cache
```

### MCP 实例宕机（C2）

**影响**：该实例的连接断开，负载均衡自动转移

**恢复**：
```bash
# 重启宕机的 MCP 实例
docker-compose -f docker/docker-compose.c2.yml up -d mcp-1
```

### 认证失败

```bash
# 检查 MCP 的 AUTH_TOKEN 是否与存储服务的用户 token 匹配
# 运行 skill-mcp auth status 查看当前认证状态

# 验证 token 是否有效
curl -H "Authorization: Bearer <your-token>" \
  http://localhost:3000/api/gateway/skills
```

## 监控和日志

### 关键日志

```
# 正常启动
[INFO] HTTP transport configured at port 4000
[INFO] RemoteSkillProvider initialized at http://storage:3000

# 网络问题
[WARN] Remote provider request failed, retrying
[WARN] Request timeout after 10000ms

# 认证问题
[WARN] Authentication failed for /api/gateway/skills

# 缓存命中
[DEBUG] Cache hit for skill:entry:my-skill
```

### 性能分析

```bash
# 查看 Prometheus 指标
curl http://localhost:3000/metrics

# 检查健康状态
curl http://localhost:3000/api/health
```

## 下一步

- 完整 [架构文档](./ARCHITECTURE.md)
- [Scenario A（本地模式）](./SCENARIO_A.md)
- [Scenario B（混合模式）](./SCENARIO_B.md)

## 常见问题

### Q: 应该选择 C1 还是 C2？

**选择 C1**：
- 开发/测试环境
- 并发用户 < 20
- 不需要高可用

**选择 C2**：
- 生产环境
- 并发用户 > 20
- 需要高可用和可扩展性

### Q: 如何从 C1 迁移到 C2？

1. 部署存储服务（C2 配置）
2. 导入现有数据（`npm run import`）
3. 部署 MCP 实例
4. 验证连接
5. 切换客户端连接

### Q: 存储数据有多大？

- 数据库大小：通常 < 100MB
- 文件存储：取决于技能数量和大小
- 缓存：配置 CACHE_MEMORY_MAX_SIZE 控制

建议用 OSS 存储大型技能包。
