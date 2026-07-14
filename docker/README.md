# Docker 部署配置

本目录包含 skill-mcp 的 Docker 部署配置，覆盖全部 5 种部署场景。

## 场景速查

| 场景 | Profile | 适用 | 命令 |
|------|---------|------|------|
| **A** | *(无)* | 本地 stdio 开发 | 无需 Docker |
| **B** | `backend` | 远程后端 + 本地 stdio proxy | `./docker/start.sh backend` |
| **C1** | `c1` | 单体 HTTP 开发/测试 | `./docker/start.sh c1` |
| **C1+HTTPS** | `c1-gateway` | 单体 + HTTPS 网关 | `./docker/start.sh c1-gateway` |
| **C2** | `c2` | 分布式生产 | `./docker/start.sh c2` |
| **C2+HTTPS** | `gateway` | 分布式 + HTTPS 网关 | `MCP_BACKEND=mcp:4000 STORAGE_BACKEND=storage:3000 ./docker/start.sh gateway` |

## 目录结构

```
docker/
├── Dockerfile              # 多阶段构建镜像
├── docker-compose.yml      # 统一配置（5 profiles）
├── Caddyfile              # Caddy 网关配置（自动 HTTPS）
├── start.sh               # 快速启动脚本
└── README.md              # 本文档
```

## 快速开始

### 使用启动脚本（推荐）

```bash
# 场景 C1：单体部署（开发/测试）
./docker/start.sh c1

# 场景 C1 + HTTPS 网关（本地开发默认 HTTP）
export DOMAIN=your-domain.com   # 设置域名启用自动 HTTPS
export ACME_EMAIL=admin@example.com
./docker/start.sh c1-gateway

# 场景 B：仅启动远程后端（配合本地 stdio proxy）
./docker/start.sh backend
# 本地接入：skill-mcp serve --remote-url http://localhost:3001

# 场景 C2：分布式部署（生产推荐）
export STORAGE_SVC_TOKEN=<your-token>
./docker/start.sh c2

# 带 HTTPS 网关（生产部署）
export DOMAIN=your-domain.com
export ACME_EMAIL=admin@example.com
export STORAGE_SVC_TOKEN=<your-token>
export MCP_BACKEND="mcp1:4000 mcp2:4000" STORAGE_BACKEND=storage:3000
./docker/start.sh gateway
```

### 手动启动

#### 场景 C1：单体部署

```bash
docker compose --profile c1 up -d --build
curl http://localhost:3000/api/health
```

#### 场景 C1 + HTTPS 网关

```bash
# 本地开发（默认 HTTP，无证书问题）
docker compose --profile c1-gateway up -d --build
curl http://localhost/api/health

# 自定义域名（自动 HTTPS）
DOMAIN=your-domain.com docker compose --profile c1-gateway up -d --build
curl https://your-domain.com/api/health
```

#### 场景 B：远程后端

```bash
docker compose --profile backend up -d --build
# 本地启动 stdio proxy 指向远程后端
skill-mcp serve --remote-url http://localhost:3001
```

#### 场景 C2：分布式部署

```bash
# 1. 创建服务账号并获取 token
export STORAGE_SVC_TOKEN=$(skill-mcp user create svc-gateway --role <role-id> | grep -oP 'token: \K.*')

# 2. 启动服务
docker compose --profile c2 up -d --build

# 3. 验证
curl http://localhost:3000/api/health
curl http://localhost:4001/api/health
curl http://localhost:4002/api/health
```

#### 带 HTTPS 网关

```bash
# 1. 设置环境变量
export DOMAIN=your-domain.com
export ACME_EMAIL=admin@example.com
export STORAGE_SVC_TOKEN=<your-token>
export MCP_BACKEND="mcp1:4000 mcp2:4000" STORAGE_BACKEND=storage:3000

# 2. 启动服务
MCP_BACKEND=mcp:4000 STORAGE_BACKEND=storage:3000 \
  docker compose --profile c2 --profile gateway up -d

# 3. 访问
curl https://your-domain.com/api/health
```

## 配置说明

### 环境变量

创建 `.env` 文件或在命令行设置：

```bash
# 基础配置
NODE_ENV=production
LOG_LEVEL=info

# 镜像配置
IMAGE=skill-mcp:latest

# 端口配置
PORT=3000                       # C1 对外端口
BACKEND_PORT=3001               # B 远程后端端口
MCP1_PORT=4001                  # C2 MCP 实例 1 对外端口
MCP2_PORT=4002                  # C2 MCP 实例 2 对外端口

# 存储配置
STORAGE_TYPE=local-fs           # local-fs 或 aliyun-oss
STORAGE_BASE_PATH=/data/skills

# C2 资源配置
STORAGE_CPU=2
STORAGE_MEM=4G
MCP_CPU=1
MCP_MEM=2G
MCP_REPLICAS=2                  # MCP 实例数

# HTTPS 配置
DOMAIN=your-domain.com
ACME_EMAIL=admin@example.com

# 服务账号 token（C2 必需）
STORAGE_SVC_TOKEN=<your-token>
```

### 资源限制

| 服务 | CPU 限制 | 内存限制 | 说明 |
|------|---------|---------|------|
| app | - | - | 单体服务 |
| backend | - | - | 远程后端 |
| storage | 2 核 | 4G | 存储服务 |
| mcp1 | 1 核 | 2G | MCP 实例 1 |
| mcp2 | 1 核 | 2G | MCP 实例 2 |
| gateway | 0.5 核 | 256M | Caddy 网关 |

## Caddy 网关特性

### 配置方式

Caddyfile 通过环境变量 `MCP_BACKEND` / `STORAGE_BACKEND` 指定后端：
- **C2+gateway**: `MCP_BACKEND="mcp1:4000 mcp2:4000"`, `STORAGE_BACKEND=storage:3000`（默认）
- **C1+gateway**: `MCP_BACKEND=app:3000`, `STORAGE_BACKEND=app:3000`

`MCP_BACKEND` 支持多个上游（空格分隔），Caddy 自动负载均衡。

### 自动 HTTPS

1. **本地开发（默认）**：`DOMAIN` 未设置或为 `localhost` 时，Caddy 走纯 HTTP，无证书问题
2. **自定义域名**：设置 `DOMAIN=your-domain.com` 后自动启用 HTTPS，从 Let's Encrypt 申请证书
3. **HTTP/2 & HTTP/3**：HTTPS 模式下默认启用
4. **自动续期**：证书到期前自动续期

### 自定义域名

1. 设置环境变量：`export DOMAIN=your-domain.com`
2. 确保域名 DNS 解析到服务器 IP
3. Caddy 自动从 Let's Encrypt 获取 HTTPS 证书

## 运维操作

### 查看日志

```bash
# 所有服务
docker compose --profile c2 logs -f

# 特定服务
docker compose --profile c2 logs -f mcp

# Caddy 访问日志
docker compose --profile gateway exec gateway cat /data/access.log
```

### 扩缩容

C2 默认启动 mcp1 + mcp2 两个 MCP 实例。如需更多实例，可在 `docker-compose.yml` 中复制 `mcp2` 定义为 `mcp3`，并更新 `start.sh` 中的 `MCP_BACKEND` 和 `gateway` 的 `depends_on`。

### 备份数据

```bash
# 备份数据库
docker compose --profile c2 exec storage \
  sqlite3 /data/skill-mcp.db ".backup /data/backup.db"

# 备份技能包
docker compose --profile c2 exec storage \
  tar czf /data/skills-backup.tar.gz /data/skills
```

### 更新服务

```bash
# 拉取最新代码并重新构建
git pull
docker compose --profile c2 build --no-cache

# 滚动更新
docker compose --profile c2 up -d --no-deps storage
docker compose --profile c2 up -d --no-deps mcp1
docker compose --profile c2 up -d --no-deps mcp2
```

## 故障排查

详见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)，包含 6 个常见问题的完整排查步骤。

### 健康检查失败

```bash
# 检查服务状态
docker compose --profile c2 ps

# 查看健康检查详情
docker inspect --format='{{json .State.Health}}' <container>

# 手动测试健康检查
docker compose --profile c2 exec mcp1 curl http://localhost:4000/api/health
```

### HTTPS 证书问题

```bash
# 查看 Caddy 证书状态
docker compose --profile gateway exec gateway caddy list-certs

# 查看 Caddy 日志
docker compose --profile gateway logs gateway

# 强制续期证书
docker compose --profile gateway exec gateway caddy renew --all
```

#### 信任 Caddy 本地 CA（推荐，一次配置永久生效）

Caddy 为 `localhost` 生成自签名证书，Node.js 默认不信任该证书。在本地开发调试 MCP inspector 时会出现证书错误。

**Step 1**：提取 Caddy 本地 CA 根证书

```bash
# 在 docker-compose.yml 所在目录执行
mkdir -p ~/.local/share/caddy
docker compose exec gateway \
  cat /data/caddy/pki/authorities/local/root.crt \
  > ~/.local/share/caddy/root.crt
```

**Step 2**：配置 Node.js 信任该证书

```bash
# 添加到 shell 配置（永久生效）
echo 'export NODE_EXTRA_CA_CERTS="$HOME/.local/share/caddy/root.crt"' >> ~/.zshrc
source ~/.zshrc
```

**Step 3**：启动 MCP inspector

```bash
npx @modelcontextprotocol/inspector
# 连接：https://localhost/mcp
```

> 另见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) 第 5 节，包含更多替代方案（跳过 TLS 验证、纯 HTTP 模式、生产域名）。

### 性能问题

```bash
# 查看资源使用
docker stats

# 查看数据库延迟
docker compose --profile c2 exec storage \
  sqlite3 /data/skill-mcp.db "SELECT COUNT(*) FROM skills;"

# 清理缓存
docker compose --profile c2 exec mcp1 rm -rf /data/cache/*
docker compose --profile c2 exec mcp2 rm -rf /data/cache/*
```

## 迁移指南

### 从旧配置迁移

旧的配置文件已移除：
- `docker-compose.c1.yml` → `--profile c1`
- `docker-compose.c2.yml` → `--profile c2`
- `docker-compose.production.yml` → `--profile c2 --profile gateway`
- `nginx.conf` → `Caddyfile`

### 新增场景

- **`backend` (Scenario B)**：独立启动 API-only 后端，配合本地 `skill-mcp serve --remote-url` 使用
- **`c1-gateway`**：C1 单体 + HTTPS 网关，Caddy 直连 `app:3000`

## 更多信息

- [生产部署指南](../docs/PRODUCTION_DEPLOYMENT.md)
- [场景详解](../docs/SCENARIOS/)
- [Caddy 文档](https://caddyserver.com/docs/)
