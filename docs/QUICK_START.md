# 快速开始指南

## 5 分钟快速上手

### 1. 安装和构建

```bash
# 克隆项目
git clone <repo>
cd skill-mcp

# 安装依赖
npm install

# 编译
npm run build
```

### 2. 启动本地 MCP（场景 A）

```bash
# 最简单的方式
npm start

# 日志显示成功：
# [INFO] Stdio transport configured
```

现在 Claude IDE 可以连接这个 MCP 并使用技能工具。

## 选择你的部署方式

### 场景 A - 本地开发

**适合：** 快速原型、单用户开发

```bash
npm start
```

👉 详见 [Scenario A 完整指南](./SCENARIO_A.md)

---

### 场景 B - 本地 MCP + 远程存储

**适合：** 多个本地客户端共享技能库

**两个终端窗口：**

```bash
# 终端 1：启动远程存储服务
cp src/config/examples/.env.scenario-b-server .env
npm start

# 终端 2：启动本地 MCP 客户端
cp src/config/examples/.env.scenario-b-client .env.local
CLOUD_SERVICE_URL=http://localhost:3000 npm start
```

👉 详见 [Scenario B 完整指南](./SCENARIO_B.md)

---

### 场景 C - 分布式 HTTP 部署

**适合：** 生产环境、多并发用户、容器化

#### C1 - 单体部署

```bash
cp src/config/examples/.env.scenario-c1 .env
TRANSPORT_TYPE=http npm start
```

#### C2 - 分离部署（推荐）

```bash
# 使用 Docker Compose
docker-compose -f docker-compose.c2.yml up -d
```

👉 详见 [Scenario C 完整指南](./SCENARIO_C.md)

---

## 核心概念速览

### Transport 层（通信方式）

| 类型 | 用途 | 场景 |
|------|------|------|
| **stdio** | 进程通信 | 本地开发（A、B） |
| **HTTP** | 网络通信 | 生产环境（C1、C2） |
| **SSE** | 流式推送 | 浏览器客户端 |

### Deployment 层（数据源）

| 模式 | 数据位置 | 用途 |
|------|---------|------|
| **standalone** | 本地存储 | 独立部署 |
| **gateway** | 远程服务 | 连接远程存储 |

### 配置组合

```
场景 A: stdio + standalone (本地)
场景 B: stdio + gateway (混合)
场景 C: HTTP + standalone (单体)
场景 C: HTTP + gateway (分离)
```

## 常用命令

```bash
# 构建和运行
npm run build                    # 编译 TypeScript
npm start                        # 启动 MCP
npm run dev                      # 监听模式

# 测试
npm test                         # 运行所有测试
npm run test:watch              # 监听测试
npm run test:coverage           # 覆盖率报告

# 数据库
npm run db:migrate              # 迁移数据库
npm run db:query                # 查询数据库

# 导入技能
npm run import -- --source <path>
```

## 环境变量快速参考

```bash
# 最重要的三个配置
TRANSPORT_TYPE=stdio|http       # 通信方式
DEPLOYMENT_MODE=standalone|gateway  # 数据源
CLOUD_SERVICE_URL=...          # 远程服务（gateway 模式）
```

完整配置见 [配置参考](./ARCHITECTURE.md#配置详解)

## 常见问题

### Q: 如何导入技能？

```bash
# 从本地目录
npm run import -- --source /path/to/skill

# 从 Git 仓库
npm run import -- --source https://github.com/user/skill.git

# 看看导入了什么
npm run db:query -- "SELECT slug, name FROM skills"
```

### Q: 如何清除所有数据重新开始？

```bash
rm -rf ./data/
npm start  # 会自动创建新数据库
```

### Q: 如何在生产环境部署？

建议使用场景 C2（分离部署）+ Docker Compose：

```bash
# 参考 docs/SCENARIO_C.md 中的 Docker Compose 示例
```

### Q: 能否在远程服务器上运行？

可以。场景 B 和 C 都支持。关键是配置 `CLOUD_SERVICE_URL` 和 `AUTH_TOKEN`。

### Q: 如何启用 API Key 认证？

```bash
ENABLE_API_KEY_AUTH=true
API_KEYS=key1,key2,key3
```

客户端连接时需要通过 `Authorization: Bearer {key}` 认证。

## 文档导航

| 内容 | 文件 |
|------|------|
| **本场景** | [Scenario A](./SCENARIO_A.md) |
| **混合场景** | [Scenario B](./SCENARIO_B.md) |
| **分布式场景** | [Scenario C](./SCENARIO_C.md) |
| **完整架构** | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| **配置参考** | [ARCHITECTURE.md#配置详解](./ARCHITECTURE.md#配置详解) |

## 下一步

1. **阅读适合你的场景指南** - Scenario A/B/C
2. **尝试导入一个测试技能** - `npm run import`
3. **在 Claude IDE 中连接** - 配置 MCP 连接
4. **查看完整文档** - [ARCHITECTURE.md](./ARCHITECTURE.md)

## 获得帮助

- 📚 查看 [完整架构文档](./ARCHITECTURE.md)
- 🐛 报告 Issue 到 GitHub
- 💬 查看相关场景的故障排查部分

---

**祝你使用愉快！** 🚀
