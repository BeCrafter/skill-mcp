# 测试指南：Phase 3-5 完整验证

本指南涵盖场景 B 和 C 的完整测试和验证。

## 前置要求

```bash
# 确保已构建项目
npm run build

# 确保依赖已安装
npm install
```

## 快速演示

### 场景 B Demo（推荐首先尝试）

最简单的方式：

```bash
./scripts/scenario-b-demo.sh
```

这个脚本会：
1. 启动远程存储服务器（port 3000）
2. 启动本地 MCP 客户端（stdio）
3. 展示两个服务的交互

**预期输出**：
```
✓ Storage server ready
✓ Local MCP client started
Both services are running!
```

### 场景 C Demo

```bash
./scripts/scenario-c-demo.sh
```

交互式选择 C1 或 C2 部署方式。

## 完整的集成测试

### 运行所有测试

```bash
npm test
```

### 运行特定场景的测试

```bash
# 场景 A 测试
npm test -- tests/e2e/scenario-a.test.ts

# 场景 B 集成测试
npm test -- tests/integration/scenario-b.test.ts

# 场景 C 分布式测试
npm test -- tests/e2e/scenario-c.test.ts
```

### 监听模式（开发时实用）

```bash
npm run test:watch
```

### 覆盖率报告

```bash
npm run test:coverage
```

## 手动测试场景 B

如果你想手动测试而不使用 demo 脚本：

### 终端 1：启动存储服务器

```bash
# 使用预配置
cp src/config/examples/.env.scenario-b-server .env.storage

# 或手动配置
export TRANSPORT_TYPE=http
export TRANSPORT_PORT=3000
export DEPLOYMENT_MODE=standalone
export AUTH_TOKEN=my-secret-key
export DATABASE_PATH=./data/storage.db

npm start
```

验证服务器启动：
```bash
# 另一个终端中
curl -H "Authorization: Bearer my-secret-key" \
  http://localhost:3000/api/gateway/health

# 应该返回：
# {"status":"ok","timestamp":"..."}
```

### 终端 2：启动本地 MCP 客户端

```bash
# 新终端窗口
export TRANSPORT_TYPE=stdio
export DEPLOYMENT_MODE=gateway
export CLOUD_SERVICE_URL=http://localhost:3000
export AUTH_TOKEN=my-secret-key

npm start
```

验证 MCP 启动：
```bash
# 日志应该显示：
# [INFO] Stdio transport configured
# [INFO] RemoteSkillProvider initialized
```

### 测试交互

#### 测试 1：验证认证

```bash
# 使用错误的 key - 应该失败
curl -H "Authorization: Bearer wrong-key" \
  http://localhost:3000/api/gateway/skills
# 返回 401

# 使用正确的 key - 应该成功
curl -H "Authorization: Bearer my-secret-key" \
  http://localhost:3000/api/gateway/skills
# 返回 200 + 技能列表
```

#### 测试 2：验证缓存

```bash
# 第一次请求（会从存储读取）
time curl -H "Authorization: Bearer my-secret-key" \
  http://localhost:3000/api/gateway/skills

# 第二次请求（应该更快，来自缓存）
time curl -H "Authorization: Bearer my-secret-key" \
  http://localhost:3000/api/gateway/skills

# 注意第二次的 real 时间应该更短
```

#### 测试 3：导入技能

在存储服务器上：

```bash
# 导入一个测试技能
npm run import -- ./path/to/skill

# 验证导入
curl -H "Authorization: Bearer my-secret-key" \
  http://localhost:3000/api/gateway/skills | python3 -m json.tool
```

## 手动测试场景 C

### C1：单体部署

```bash
export TRANSPORT_TYPE=http
export TRANSPORT_PORT=3000
export DEPLOYMENT_MODE=standalone
export MCP_ONLY_MODE=false

npm start
```

验证：
```bash
# 检查管理 API
curl http://localhost:3000/api/health

# 检查网关 API
curl http://localhost:3000/api/gateway/health

# 两个都应该返回 200
```

### C2：分离部署

#### 启动存储服务（Terminal 1）

```bash
export TRANSPORT_TYPE=http
export TRANSPORT_PORT=3000
export DEPLOYMENT_MODE=standalone
export MCP_ONLY_MODE=true
export AUTH_TOKEN=c2-key

npm start
```

#### 启动 MCP 服务（Terminal 2）

```bash
export TRANSPORT_TYPE=http
export TRANSPORT_PORT=4000
export DEPLOYMENT_MODE=gateway
export CLOUD_SERVICE_URL=http://localhost:3000
export AUTH_TOKEN=c2-key
export MCP_ONLY_MODE=true

npm start
```

验证分离：
```bash
# 存储服务只提供 /api/gateway/*
curl -H "Authorization: Bearer c2-key" \
  http://localhost:3000/api/gateway/health  # 200

curl http://localhost:3000/api/health  # 401 or 404

# MCP 服务只提供 /mcp/*
# (MCP 协议测试需要特殊工具)
```

## 性能测试

### 并发请求测试

```bash
# 使用 Apache Bench
ab -n 100 -c 10 http://localhost:3000/api/health

# 或 wrk
wrk -t4 -c100 -d30s http://localhost:3000/api/health
```

### 缓存效果测试

```bash
# 第一次请求（无缓存）
time curl http://localhost:3000/api/gateway/skills \
  -H "Authorization: Bearer test-key"

# 多次请求（有缓存）
for i in {1..10}; do
  time curl http://localhost:3000/api/gateway/skills \
    -H "Authorization: Bearer test-key"
done
```

预期：第一次 ~100-200ms，后续请求 < 10ms

## 故障排查

### 问题：无法连接到存储服务

```bash
# 1. 检查服务是否运行
ps aux | grep npm

# 2. 检查端口是否开放
lsof -i :3000

# 3. 检查日志
# 查看 Terminal 中的输出

# 4. 手动测试连接
curl http://localhost:3000/api/gateway/health
```

### 问题：认证失败

```bash
# 1. 验证 AUTH_TOKEN 配置
echo $AUTH_TOKEN

# 2. 验证认证请求格式
curl -v http://localhost:3000/api/gateway/health \
  -H "Authorization: Bearer your-token"

# 3. 查看服务器日志中的认证错误
```

### 问题：缓存未生效

```bash
# 1. 清除缓存目录
rm -rf ./data/cache

# 2. 重启服务
# (Ctrl+C 然后重新启动)

# 3. 验证缓存配置
echo $CACHE_FILE_ENABLED
echo $CACHE_FILE_DIR
```

## 持续集成建议

### GitHub Actions 示例

```yaml
name: Run Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-node@v3
        with:
          node-version: '22'
      
      - run: npm install
      - run: npm run build
      - run: npm test
      - run: npm run test:coverage
```

## 测试检查清单

完成以下验证：

### 场景 B 验证

- [ ] 存储服务器启动并响应健康检查
- [ ] MCP 客户端启动并连接到存储
- [ ] Bearer Token 认证工作正常
  - [ ] 有效 JWT token 返回 200
  - [ ] 无效/过期 token 返回 401
  - [ ] 缺少 Authorization 头返回 401
- [ ] 缓存机制工作正常
  - [ ] 第一次请求较慢
  - [ ] 后续请求更快
- [ ] 技能导入和访问工作正常
- [ ] 集成测试通过：`npm test -- tests/integration/scenario-b.test.ts`

### 场景 C 验证

**C1 单体部署**：
- [ ] HTTP 服务器启动在 port 3000
- [ ] 同时提供 /mcp/* 和 /api/* 端点
- [ ] 多个并发连接能正常处理
- [ ] 集成测试通过：`npm test -- tests/e2e/scenario-c.test.ts`

**C2 分离部署**：
- [ ] 存储服务启动在 port 3000（仅 /api/gateway/*）
- [ ] MCP 服务启动在 port 4000（仅 /mcp/*）
- [ ] MCP 通过认证正确连接到存储
- [ ] 存储和 MCP 可独立重启
- [ ] 集成测试通过

## 下一步

- 完成所有测试后，参考 [SCENARIO_C.md](./SCENARIOS/SCENARIO_C.md) 中的 Docker 部署示例
- 为生产部署配置监控和日志，参考 [PRODUCTION_DEPLOYMENT.md](./PRODUCTION_DEPLOYMENT.md)
