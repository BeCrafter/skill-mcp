# 场景 B：本地 + 远程混合部署

stdio MCP + 远程文件服务

## 概述

场景 B 适合以下场景：
- 本地 MCP 服务连接到远程存储
- 多个本地 MCP 实例共享同一存储
- 需要中央技能管理
- 但 MCP 通道仍在本地

## 架构

```
Claude IDE ↔ [stdio] ↔ MCP(Local) ↔ [HTTP + Bearer Token] ↔ Storage Server ↔ LocalFS/OSS
```

## 部署步骤

### 步骤 1：启动远程存储服务

在服务器上启动存储服务：

```bash
# 进入项目目录
cd /path/to/skill-mcp

# 创建配置文件
cp src/config/examples/.env.scenario-b-server .env.storage

# 编辑 .env.storage（可选）
# 修改 TRANSPORT_PORT、STORAGE_BASE_PATH 等

# 启动服务器
export $(cat .env.storage | xargs)
npm start
```

启动成功后，应该看到：
```
Starting MCP Server in standalone mode

listening
  mode: standalone
  transport: http
  port: 3000
  host: 0.0.0.0

  ✓  Ready
```

验证健康检查：
```bash
curl http://localhost:3000/api/gateway/health
# 应返回：{"status":"ok","timestamp":"..."}
```

### 步骤 2：启动本地 MCP 客户端

在本地机器上启动 MCP：

```bash
# 进入项目目录
cd /path/to/skill-mcp

# 创建配置文件
cp src/config/examples/.env.scenario-b-client .env.local

# 编辑 .env.local - 重要！修改 CLOUD_SERVICE_URL 为实际的服务器地址
# 例如：CLOUD_SERVICE_URL=http://server.example.com:3000
# 或本地测试：CLOUD_SERVICE_URL=http://localhost:3000

# 启动 MCP
export $(cat .env.local | xargs)
npm start
```

启动成功后，应该看到：
```
Starting MCP Server in gateway mode
```

此时 Claude IDE 可以通过 stdio 连接并使用远程技能。

### 步骤 3：验证连接

在 MCP 启动后，测试连接：

```bash
# 测试远程服务的 API
curl -H "Authorization: Bearer test-key-1" \
  http://localhost:3000/api/gateway/skills

# 应返回技能列表（即使为空）
{"success":true,"data":[],"total":0,"offset":0,"limit":50}
```

## 配置详解

### 服务器端配置 (.env.scenario-b-server)

```bash
# 必需配置
DEPLOYMENT_MODE=standalone              # 使用本地 Provider
TRANSPORT_TYPE=http                     # HTTP 传输
TRANSPORT_PORT=3000                     # 服务器端口

# 可选配置
STORAGE_BASE_PATH=./data/skills         # 存储路径
CACHE_MEMORY_MAX_SIZE=500              # 内存缓存大小
```

> **认证说明**：`/api/gateway/*` 端点需要 Bearer Token 认证（`/api/gateway/health` 除外）。
> 创建用户和角色请参考：`skill-mcp init` 或 `skill-mcp user create`。

### 客户端配置 (.env.scenario-b-client)

```bash
# 必需配置
DEPLOYMENT_MODE=gateway               # 使用远程 Provider
CLOUD_SERVICE_URL=http://...          # 远程服务 URL
AUTH_TOKEN=test-key-1                 # 连接用的 Bearer Token

# 可选配置
CACHE_MEMORY_MAX_SIZE=100             # 客户端缓存（通常较小）
CACHE_FILE_ENABLED=true               # 启用文件缓存（跨进程共享）
```

## 操作指南

### 管理技能（在服务器上）

```bash
# 导入新技能到服务器
npm run import -- /path/to/skill

# 查看已导入的技能
sqlite3 data/skill-mcp.db "SELECT slug, name, version FROM skills"

# 更新技能
# 通过管理 API：PUT /api/skills/{slug}

# 删除技能
# 通过管理 API：DELETE /api/skills/{slug}
```

### 客户端访问

本地 MCP 客户端会自动通过 RemoteProvider 访问远程技能：

```bash
# MCP 的 skill_list 工具会调用：
# GET /api/gateway/skills (带认证)

# MCP 的 skill_view 工具会调用：
# GET /api/gateway/skills/{slug}/entry (带认证)

# MCP 的 skill_file 工具会调用：
# POST /api/gateway/skills/{slug}/files (带认证)
```

## 缓存机制

### 两层缓存

1. **L1 缓存（内存 LRU）**
   - 位置：进程内存
   - 大小：CACHE_MEMORY_MAX_SIZE
   - TTL：600 秒
   - 优点：极快

2. **L2 缓存（文件）**
   - 位置：./data/cache/
   - TTL：1200 秒（L1 的 2 倍）
   - 优点：跨进程共享、持久化

### 缓存键设计

```
skill:entry:{slug}              # 技能主文件
skill:file:{slug}:{path}        # 单个文件
skill:files:{slug}:{paths}      # 文件集合
skill:filetree:{slug}           # 文件树结构
```

### 清除缓存

```bash
# 清除所有文件缓存
rm -rf ./data/cache/

# 清除特定技能的缓存
find ./data/cache/ -name "*my-skill*" -delete

# 重启进程清除内存缓存
# (MCP 进程重启)
```

## 网络连接问题排查

### 问题：无法连接到远程服务

```bash
# 1. 检查服务器是否运行
curl http://server:3000/api/gateway/health

# 2. 检查防火墙
netstat -an | grep 3000

# 3. 检查配置中的 URL
echo $CLOUD_SERVICE_URL
```

### 问题：认证失败 (401)

```bash
# 1. 验证 Bearer Token 配置
# 确保客户端的 AUTH_TOKEN 与服务器端创建的用户 token 匹配

# 2. 测试认证
curl -H "Authorization: Bearer <your-token>" \
  http://server:3000/api/gateway/skills

# 3. 查看服务器日志
# [WARN] Authentication failed
```

### 问题：连接超时

```bash
# 1. 检查网络延迟
ping server

# 2. 查看 MCP 日志
# [WARN] Remote provider request failed, retrying
# [WARN] Request timeout

# 3. 增加超时配置（暂未支持，当前固定 10 秒）
```

## 生产环境建议

### 安全

```bash
# 1. 使用 RBAC 控制访问
skill-mcp role create --name reader --tags "skill:read"
skill-mcp user create --name client-app --role-ids <role-id>

# 2. 使用 HTTPS（需要反向代理如 Nginx）
CLOUD_SERVICE_URL=https://secure.example.com

# 3. 限制客户端 IP（应用层或防火墙）

# 4. 定期轮换用户 Token（skill-mcp user rotate-token）
```

### 性能

```bash
# 1. 调整缓存大小
CACHE_MEMORY_MAX_SIZE=1000  # 增加以缓存更多

# 2. 启用文件缓存（跨进程共享）
CACHE_FILE_ENABLED=true

# 3. 使用高性能存储（OSS）
STORAGE_TYPE=aliyun-oss
```

### 监控

```bash
# 监控连接
# - RemoteProvider 连接次数
# - 缓存命中率
# - 平均响应时间

# 监控访问日志
# - 查询 /api/admin/access-logs 端点
```

## 多客户端场景

场景 B 支持多个本地 MCP 实例连接到同一远程存储：

```
MCP-1 ↔ [HTTP] ↔ Storage
MCP-2 ↔ [HTTP] ↔ Storage
MCP-3 ↔ [HTTP] ↔ Storage
```

**配置相同**：所有客户端使用相同的 CLOUD_SERVICE_URL 和 AUTH_TOKEN

**缓存独立**：每个客户端有自己的 L1 和 L2 缓存

**数据一致**：所有客户端访问相同的远程数据，通过 TTL 保证一致性

## Docker 部署示例

### 服务器 Dockerfile

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN npm run build

ENV TRANSPORT_TYPE=http
ENV DEPLOYMENT_MODE=standalone

EXPOSE 3000

CMD ["npm", "start"]
```

### 客户端 Dockerfile

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN npm run build

ENV TRANSPORT_TYPE=stdio
ENV DEPLOYMENT_MODE=gateway

CMD ["npm", "start"]
```

### Docker Compose

```yaml
version: '3.8'

services:
  storage:
    image: skill-mcp:latest
    ports:
      - "3000:3000"
    environment:
      TRANSPORT_TYPE: http
      DEPLOYMENT_MODE: standalone
      # RBAC: create a user+token via `skill-mcp init` or `skill-mcp user create`,
      # then clients use that token as AUTH_TOKEN.

  mcp-client-1:
    image: skill-mcp:latest
    depends_on:
      - storage
    environment:
      TRANSPORT_TYPE: stdio
      DEPLOYMENT_MODE: gateway
      CLOUD_SERVICE_URL: http://storage:3000
      AUTH_TOKEN: storage-key-prod
```

## 故障恢复

### 服务器宕机

1. 客户端的本地缓存仍然可用（TTL 内）
2. 重启服务器后自动重连
3. 缓存超时后无法访问（需要重新启动客户端）

### 恢复步骤

```bash
# 1. 检查服务器
curl http://server:3000/api/gateway/health

# 2. 重启客户端（如果缓存过期）
npm start

# 3. 验证连接
# MCP 日志显示成功连接
```

## 下一步

- 了解 [Scenario C（分布式部署）](./SCENARIO_C.md)
- 完整 [架构文档](./ARCHITECTURE.md)
- [Scenario A（本地模式）](./SCENARIO_A.md)
