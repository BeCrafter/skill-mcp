# Docker 部署配置

本目录包含 skill-mcp 的 Docker 部署配置，支持多种部署场景。

## 目录结构

```
docker/
├── Dockerfile              # 多阶段构建镜像
├── docker-compose.yml      # 统一配置（支持 C1/C2/Gateway）
├── Caddyfile              # Caddy 网关配置（自动 HTTPS）
├── start.sh               # 快速启动脚本
└── README.md              # 本文档
```
## 快速开始

### 使用启动脚本（推荐）

```bash
# 场景 C1：单体部署（开发/测试）
./docker/start.sh c1

# 场景 C2：分布式部署（生产推荐）
export STORAGE_SVC_TOKEN=<your-token>
./docker/start.sh c2

# 带 HTTPS 网关（生产部署）
export DOMAIN=your-domain.com
export ACME_EMAIL=admin@example.com
export STORAGE_SVC_TOKEN=<your-token>
./docker/start.sh gateway
```

### 手动启动

#### 场景 C1：单体部署

```bash
docker compose --profile c1 up -d --build
curl http://localhost:3000/api/health
```

#### 场景 C2：分布式部署

```bash
# 1. 创建服务账号并获取 token
export STORAGE_SVC_TOKEN=$(skill-mcp user create svc-gateway --role <role-id> | grep -oP 'token: \K.*')

# 2. 启动服务
docker compose --profile c2 up -d --build

# 3. 验证
curl http://localhost:3000/api/health
```

#### 带 HTTPS 网关

```bash
# 1. 设置环境变量
export DOMAIN=your-domain.com
export ACME_EMAIL=admin@example.com
export STORAGE_SVC_TOKEN=<your-token>

# 2. 启动服务
docker compose --profile c2 --profile gateway up -d

# 3. 访问
https://your-domain.com/mcp
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

# 端口配置（C1 模式）
PORT=3000

# 存储配置
STORAGE_TYPE=local-fs        # local-fs 或 aliyun-oss
STORAGE_BASE_PATH=/data/skills

# C2 资源配置
STORAGE_CPU=2
STORAGE_MEM=4G
MCP_CPU=1
MCP_MEM=2G
MCP_REPLICAS=2               # MCP 实例数
MCP_PORT=4000                 # MCP 对外端口

# HTTPS 配置
DOMAIN=your-domain.com
ACME_EMAIL=admin@example.com

# 服务账号 token（C2 必需）
STORAGE_SVC_TOKEN=<your-token>
```

### 资源限制

| 服务 | CPU 限制 | 内存限制 | 说明 |
|------|---------|---------|------|
| storage | 2 核 | 4G | 存储服务 |
| mcp | 1 核/实例 | 2G/实例 | MCP 服务 |
| gateway | 0.5 核 | 256M | Caddy 网关 |

## Caddy 网关特性

### 自动 HTTPS

Caddy 自动处理 HTTPS：

1. **Let's Encrypt 集成**：自动申请和续期证书
2. **HTTP/2 & HTTP/3**：默认启用
3. **自动重定向**：HTTP → HTTPS
4. **本地开发**：localhost 自动生成本地证书

### 配置示例

```Caddyfile
# 生产环境
{$DOMAIN:localhost} {
    handle /mcp* {
        reverse_proxy mcp:4000
    }
    handle /api/gateway/* {
        reverse_proxy storage:3000 {
            header_up Authorization {>Authorization}
        }
    }
    respond /health 200
}
```

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

```bash
# 扩展 MCP 实例
docker compose --profile c2 up -d --scale mcp=3

# 或修改环境变量
export MCP_REPLICAS=3
docker compose --profile c2 up -d
```

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
docker compose --profile c2 up -d --no-deps mcp
```

## 故障排查

### 健康检查失败

```bash
# 检查服务状态
docker compose --profile c2 ps

# 查看健康检查详情
docker inspect --format='{{json .State.Health}}' <container>

# 手动测试健康检查
docker compose --profile c2 exec mcp curl http://localhost:4000/api/health
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

### 性能问题

```bash
# 查看资源使用
docker stats

# 查看数据库延迟
docker compose --profile c2 exec storage \
  sqlite3 /data/skill-mcp.db "SELECT COUNT(*) FROM skills;"

# 清理缓存
docker compose --profile c2 exec mcp rm -rf /data/cache/*
```

## 迁移指南

### 从 Nginx 迁移到 Caddy

1. **备份现有配置**：
   ```bash
   cp nginx.conf nginx.conf.bak
   ```

2. **更新 docker-compose**：
   - 使用新的 `docker-compose.yml`
   - 使用 `--profile gateway` 启用 Caddy

3. **配置域名**：
   - Caddy 自动获取 HTTPS 证书
   - 无需手动配置 SSL

4. **测试部署**：
   ```bash
   docker compose --profile c2 --profile gateway up -d
   ```

### 从旧配置迁移

旧的配置文件已移除：
- `docker-compose.c1.yml` → `--profile c1`
- `docker-compose.c2.yml` → `--profile c2`
- `docker-compose.production.yml` → `--profile c2 --profile gateway`
- `nginx.conf` → `Caddyfile`

## 更多信息

- [生产部署指南](../docs/PRODUCTION_DEPLOYMENT.md)
- [场景详解](../docs/SCENARIOS/)
- [Caddy 文档](https://caddyserver.com/docs/)
