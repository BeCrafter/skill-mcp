# MCP 服务器多场景架构文档

## 概述

本项目实现了一个灵活的 MCP（Model Context Protocol）服务器，支持三种部署场景：

1. **本地独立模式（Scenario A）**：stdio MCP + 本地文件存储
2. **混合部署模式（Scenario B）**：stdio MCP + 远程文件服务
3. **分布式部署模式（Scenario C）**：HTTP/SSE MCP + 可选远程存储

## 架构层次

### Layer 1: Transport 层（通信方式）

支持三种通信方式，通过 `TRANSPORT_TYPE` 配置：

- **stdio** - 用于本地进程通信（开发和本地部署）
- **sse** - Server-Sent Events（用于浏览器和 HTTP 客户端）
- **http** - 流式 HTTP（生产环境推荐）

### Layer 2: Provider 层（数据源）

支持两种数据源模式，通过 `DEPLOYMENT_MODE` 配置：

- **standalone** - 使用本地存储和 SQLite 数据库（LocalSkillProvider）
- **gateway** - 连接到远程服务（RemoteSkillProvider）

### Layer 3: API 层

提供三种 API 端点：

- **/mcp/*** - MCP 协议端点（由 MCP SDK 处理）
- **/api/*** - 内部管理 API（本地使用，无认证）
- **/api/gateway/*** - 云端 API（RemoteProvider 调用，需认证）

### Layer 4: 存储/缓存层

- **CompositeCacheProvider** - 两层缓存（L1 内存 LRU + L2 文件持久化）
- **IStorageProvider** - 存储抽象（本地 FS 或阿里云 OSS）
- **SQLite 数据库** - 技能元数据和文件索引

## 部署场景详解

### 场景 A：本地独立模式

```bash
# 配置
TRANSPORT_TYPE=stdio
DEPLOYMENT_MODE=standalone
STORAGE_TYPE=local-fs

# 启动
npm start

# 通信方式
Claude IDE ↔ [stdio] ↔ MCP Server ↔ LocalFS + SQLite
```

**特点**：
- 完全独立，无网络依赖
- 适合本地开发和测试
- 单用户，数据不共享

**验证**：
```bash
# 启动后，MCP 工具通过 stdio 与 Claude IDE 通信
# 日志输出：Stdio transport configured
```

### 场景 B：混合部署模式

**服务器端**（远程存储服务）：
```bash
TRANSPORT_TYPE=http
TRANSPORT_PORT=3000
DEPLOYMENT_MODE=standalone
ENABLE_API_KEY_AUTH=true
API_KEYS=test-key-1

npm start -- --transport http --port 3000
```

**客户端**（本地 MCP）：
```bash
TRANSPORT_TYPE=stdio
DEPLOYMENT_MODE=gateway
CLOUD_SERVICE_URL=http://server:3000
AUTH_TOKEN=test-key-1

npm start -- --transport stdio --mode gateway
```

**通信方式**：
```
Claude IDE ↔ [stdio] ↔ MCP(Local) ↔ [HTTP+API Key] ↔ Storage Server ↔ LocalFS + SQLite
```

**特点**：
- 本地 MCP 支持多个客户端
- 远程存储集中管理
- 通过 API Key 认证保护
- 本地缓存减少网络请求

### 场景 C1：单体 HTTP 部署

```bash
TRANSPORT_TYPE=http
TRANSPORT_PORT=3000
DEPLOYMENT_MODE=standalone
MCP_ONLY_MODE=false

npm start -- --transport http --port 3000
```

**通信方式**：
```
Claude IDE ↔ [HTTP/SSE] ↔ MCP Server ↔ LocalFS + SQLite
多个客户端并发连接，共享本地存储
```

### 场景 C2：分离部署（推荐生产）

**存储服务**（端口 3000）：
```bash
TRANSPORT_TYPE=http
DEPLOYMENT_MODE=standalone
MCP_ONLY_MODE=true
ENABLE_API_KEY_AUTH=true

npm start -- --transport http --port 3000 --mode standalone
```

**MCP 通道**（端口 4000）：
```bash
TRANSPORT_TYPE=http
DEPLOYMENT_MODE=gateway
CLOUD_SERVICE_URL=http://storage:3000
MCP_ONLY_MODE=true

npm start -- --transport http --port 4000 --mode gateway
```

**优点**：
- 独立扩展存储和 MCP 层
- 多个 MCP 实例可共用一个存储
- 便于容器化和 Kubernetes 部署

## 配置详解

### 环境变量

#### Transport 配置
```bash
TRANSPORT_TYPE=stdio|sse|http          # 通信方式（默认 stdio）
TRANSPORT_PORT=3000                    # HTTP 服务器端口
TRANSPORT_HOST=0.0.0.0                 # 监听地址
MCP_ONLY_MODE=false                    # 仅暴露 MCP 端点（禁用其他 API）
```

#### Deployment 配置
```bash
DEPLOYMENT_MODE=standalone|gateway     # standalone 用本地数据，gateway 用远程
CLOUD_SERVICE_URL=http://...           # 远程服务 URL（gateway 模式必需）
AUTH_TOKEN=...                         # 连接远程服务的 API Key
```

#### Storage 配置
```bash
STORAGE_TYPE=local-fs|aliyun-oss       # 存储后端
STORAGE_BASE_PATH=./data/skills        # 本地存储路径
```

#### 缓存配置
```bash
CACHE_MEMORY_ENABLED=true              # L1 内存缓存
CACHE_MEMORY_MAX_SIZE=500              # 最多缓存条目数
CACHE_FILE_ENABLED=true                # L2 文件缓存
CACHE_FILE_DIR=./data/cache            # 文件缓存目录
```

#### 认证配置
```bash
ENABLE_API_KEY_AUTH=false              # 启用 API Key 认证
API_KEYS=key1,key2,key3                # 多个有效 Key（逗号分隔）
```

### 配置文件示例

所有示例文件位于 `src/config/examples/`：

- `.env.scenario-a` - 本地独立模式
- `.env.scenario-b-server` - 远程存储服务器
- `.env.scenario-b-client` - 本地 MCP 客户端
- `.env.scenario-c1` - 单体 HTTP 部署
- `.env.scenario-c2-storage` - 分离部署的存储服务
- `.env.scenario-c2-mcp` - 分离部署的 MCP 通道

使用示例：
```bash
cp src/config/examples/.env.scenario-a .env.local
npm start
```

## API 端点对比

### /api/* (Admin API - 内部使用)
- 无认证要求
- 完整的管理功能（创建、更新、删除）
- 只在内部网络访问

### /api/gateway/* (Cloud API - RemoteProvider 调用)
- 支持 API Key 认证（可选）
- 只读和基础操作（列表、查询、读取）
- 用于远程访问

#### 端点对照

| 功能 | Admin | Gateway |
|------|-------|---------|
| 列表技能 | `GET /api/skills` | `GET /api/gateway/skills` |
| 按 Slug 查询 | `GET /api/skills/{slug}` | `GET /api/gateway/skills/{slug}` |
| 按 ID 查询 | - | `GET /api/gateway/skills/{id}` |
| 获取主文件 | `GET /api/skills/{slug}/entry` | `GET /api/gateway/skills/{slug}/entry` |
| 批量读文件 | `POST /api/skills/{slug}/files` | `POST /api/gateway/skills/{slug}/files` |
| 获取文件树 | `GET /api/skills/{slug}/file-tree` | `GET /api/gateway/skills/{slug}/file-tree` |
| 导入技能 | `POST /api/skills` | - |
| 更新技能 | `PUT /api/skills/{slug}` | - |
| 删除技能 | `DELETE /api/skills/{slug}` | - |

## RemoteProvider 实现细节

### 重试机制
- 自动重试失败请求（最多 3 次）
- 指数退避策略（500ms, 1s, 2s）
- 只重试网络错误和超时

### 超时处理
- 请求超时：10 秒
- 通过 AbortController 实现
- 超时后自动重试（如果未达重试限制）

### 缓存策略
- 所有查询结果在本地缓存
- TTL：600 秒（10 分钟）
- 缓存命中时跳过网络请求
- 适合网络不稳定场景

### 认证处理
- Authorization Header：`Bearer {API_KEY}`
- 由 MCP 客户端配置提供
- 服务器端通过 apikey-auth 中间件验证

## 安全考虑

### 认证
- API Key 认证可选，适合不同安全需求
- 生产环境强烈建议启用

### 路径验证
- 所有文件路径通过 `validateFilePath()` 验证
- 防止目录遍历攻击

### 注入扫描
- 所有技能内容通过 `scanForInjection()` 检查
- 检测可疑的代码模式

## 监控和日志

### 日志级别
- `debug` - 详细请求信息
- `info` - 关键操作
- `warn` - 认证失败、网络错误
- `error` - 严重错误

### 关键日志
```
Gateway API route                          # API 路由信息
API key authentication passed              # 认证成功
Remote provider request failed, retrying   # 重试日志
Request handler error                      # 错误处理
```

### 访问日志
- 记录所有 skill_list/view/file 操作
- 包含请求延迟、访问时间
- 存储在 access_logs 表中

## 部署建议

### 开发环境
- 使用场景 A（本地独立）
- 禁用认证
- 启用所有日志

### 测试环境
- 使用场景 B（混合模式）
- 启用基础认证
- 验证跨服务通信

### 生产环境
- 使用场景 C2（分布式）
- 启用完整认证
- 使用高可用存储（OSS）
- 配置监控和告警
- 定期备份数据库

## 故障排查

### MCP 连接失败
1. 检查 TRANSPORT_TYPE 配置
2. 如果是 HTTP，检查端口是否开放
3. 查看日志中的 transport 初始化信息

### RemoteProvider 连接失败
1. 验证 CLOUD_SERVICE_URL 可达
2. 检查 AUTH_TOKEN 是否正确
3. 查看重试日志和超时错误

### 认证失败 (401)
1. 确认 API_KEYS 配置
2. 验证请求头包含 `Authorization: Bearer {key}`
3. 检查 ENABLE_API_KEY_AUTH 是否启用

### 缓存问题
1. 清除 L2 缓存：`rm -rf ./data/cache`
2. 重启服务重置 L1 缓存
3. 检查 CACHE_FILE_ENABLED 配置

## 扩展和定制

### 添加新的 Storage 后端
1. 实现 `IStorageProvider` 接口
2. 在 schema.ts 中添加配置
3. 在 config/index.ts 中初始化

### 添加新的 Permission Filter
1. 实现 `IPermissionFilter` 接口
2. 在 serve-cmd.ts 中替换默认实现
3. 编写相应的单元测试

### 添加新的 Transport
1. 参考 SSE 或 HTTP 实现
2. 实现创建 MCP 服务器的逻辑
3. 在 app.ts 中添加路由处理

## 常见问题

### Q: 如何在 RemoteProvider 中处理缓存失效？
A: 当技能更新时，客户端应清除相关缓存键：
```typescript
await cache.clearByPrefix(`skill:entry:${slug}`);
await cache.clearByPrefix(`skill:file:${slug}`);
```

### Q: 能否使用 RemoteProvider 连接到另一个 MCP 实例？
A: 可以。RemoteProvider 调用 HTTP API，不限于同一项目。确保目标服务实现了相同的 `/api/gateway/*` API。

### Q: 如何在 Kubernetes 中部署？
A: 参考场景 C2 分离部署，使用 Docker Compose 或 Helm 作为参考。

## 更新日志

### v0.0.1 (当前)
- 支持三种部署场景
- 实现 API Key 认证
- RemoteProvider 重试和超时
- 完整的配置示例
