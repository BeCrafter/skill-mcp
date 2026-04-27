# 生产部署指南

完整的生产环境部署、监控和运维指南。

## 部署架构选择

### 推荐配置：场景 C2（分离部署）

为什么选择 C2：
- **高可用性** - 存储和 MCP 独立运行
- **可扩展性** - 多个 MCP 实例共享一个存储
- **易于维护** - 职责分离，独立升级
- **性能** - 使用高性能存储（OSS）

```
┌─────────────────────────────────────────────────┐
│  Load Balancer (Nginx/HAProxy)                  │
├──────────────┬──────────────┬──────────────┐
│              │              │              │
▼              ▼              ▼              ▼
MCP-1:4000   MCP-2:4000   MCP-3:4000   ...
   ▲            ▲            ▲
   └────────────┴────────────┘
         │
         ▼
   Storage:3000 ─────→ OSS / Cloud Storage
```

## 使用 Docker 部署

### Dockerfile

```dockerfile
FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy and build
COPY . .
RUN npm run build

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:${TRANSPORT_PORT:-3000}/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

EXPOSE 3000 4000

CMD ["npm", "start"]
```

### Docker Compose for Production

```yaml
# docker-compose.production.yml
version: '3.8'

services:
  # Storage Service
  storage:
    image: skill-mcp:latest
    restart: always
    environment:
      NODE_ENV: production
      TRANSPORT_TYPE: http
      TRANSPORT_PORT: 3000
      DEPLOYMENT_MODE: standalone
      MCP_ONLY_MODE: "true"
      ENABLE_API_KEY_AUTH: "true"
      API_KEYS: ${STORAGE_API_KEY}
      STORAGE_TYPE: aliyun-oss
      STORAGE_BUCKET: ${OSS_BUCKET}
      STORAGE_REGION: ${OSS_REGION}
      STORAGE_ACCESS_KEY_ID: ${OSS_ACCESS_KEY_ID}
      STORAGE_ACCESS_KEY_SECRET: ${OSS_ACCESS_KEY_SECRET}
      DATABASE_PATH: /data/skill-mcp.db
      CACHE_FILE_DIR: /data/cache
    volumes:
      - storage-data:/data
    networks:
      - internal
    healthcheck:
      test: ["CMD", "curl", "-f", "-H", "Authorization: Bearer ${STORAGE_API_KEY}", "http://localhost:3000/api/gateway/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # MCP Service 1
  mcp-1:
    image: skill-mcp:latest
    restart: always
    environment:
      NODE_ENV: production
      TRANSPORT_TYPE: http
      TRANSPORT_PORT: 4000
      DEPLOYMENT_MODE: gateway
      CLOUD_SERVICE_URL: http://storage:3000
      AUTH_TOKEN: ${STORAGE_API_KEY}
      MCP_ONLY_MODE: "true"
      DATABASE_PATH: /data/skill-mcp.db
      CACHE_FILE_DIR: /data/cache
    volumes:
      - mcp-1-cache:/data
    networks:
      - internal
      - external
    depends_on:
      storage:
        condition: service_healthy

  # MCP Service 2
  mcp-2:
    image: skill-mcp:latest
    restart: always
    environment:
      NODE_ENV: production
      TRANSPORT_TYPE: http
      TRANSPORT_PORT: 4000
      DEPLOYMENT_MODE: gateway
      CLOUD_SERVICE_URL: http://storage:3000
      AUTH_TOKEN: ${STORAGE_API_KEY}
      MCP_ONLY_MODE: "true"
      DATABASE_PATH: /data/skill-mcp.db
      CACHE_FILE_DIR: /data/cache
    volumes:
      - mcp-2-cache:/data
    networks:
      - internal
      - external
    depends_on:
      storage:
        condition: service_healthy

  # Nginx Load Balancer
  nginx:
    image: nginx:alpine
    restart: always
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    networks:
      - external
    depends_on:
      - mcp-1
      - mcp-2

volumes:
  storage-data:
  mcp-1-cache:
  mcp-2-cache:

networks:
  internal:
    internal: true
  external:
```

### Nginx 配置

```nginx
# nginx.conf
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 2048;
    use epoll;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=mcp_limit:10m rate=100r/s;

    # MCP Backend
    upstream mcp_backend {
        least_conn;
        server mcp-1:4000 max_fails=3 fail_timeout=30s;
        server mcp-2:4000 max_fails=3 fail_timeout=30s;
    }

    server {
        listen 80;
        server_name _;
        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl http2;
        server_name api.example.com;

        ssl_certificate /etc/nginx/ssl/cert.pem;
        ssl_certificate_key /etc/nginx/ssl/key.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;
        ssl_prefer_server_ciphers on;
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 10m;

        # Security headers
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "SAMEORIGIN" always;

        # MCP endpoint
        location /mcp {
            limit_req zone=mcp_limit burst=50 nodelay;

            proxy_pass http://mcp_backend;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            # Timeouts
            proxy_connect_timeout 10s;
            proxy_send_timeout 30s;
            proxy_read_timeout 30s;
        }

        # Health check for monitoring
        location /health {
            access_log off;
            return 200 "ok\n";
        }
    }
}
```

### 启动生产环境

```bash
# 1. 创建 .env 文件
cat > .env.production << 'EOF'
STORAGE_API_KEY=your-strong-api-key-here
OSS_BUCKET=your-oss-bucket
OSS_REGION=oss-cn-beijing
OSS_ACCESS_KEY_ID=your-access-key-id
OSS_ACCESS_KEY_SECRET=your-access-key-secret
EOF

# 2. 构建镜像
docker build -t skill-mcp:latest .

# 3. 启动服务
docker-compose -f docker-compose.production.yml up -d

# 4. 验证部署
docker-compose -f docker-compose.production.yml ps
```

## 监控和日志

### Prometheus 指标

在应用中添加指标收集（第 5 阶段优化）：

```typescript
// 示例指标
const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
});

const cacheHitRate = new Gauge({
  name: 'cache_hit_rate',
  help: 'Cache hit rate percentage',
});

const remoteProviderErrors = new Counter({
  name: 'remote_provider_errors_total',
  help: 'Total remote provider errors',
  labelNames: ['type'],
});
```

### ELK Stack 日志收集

```yaml
# Filebeat 配置
filebeat.inputs:
- type: container
  enabled: true
  paths:
    - '/var/lib/docker/containers/*/*.log'
  json.message_key: log
  json.keys_under_root: true

output.elasticsearch:
  hosts: ["elasticsearch:9200"]
  index: "skill-mcp-%{+yyyy.MM.dd}"
```

### 关键告警规则

```yaml
groups:
  - name: skill-mcp
    rules:
      - alert: HighErrorRate
        expr: rate(errors_total[5m]) > 0.05
        for: 5m

      - alert: StorageUnavailable
        expr: up{job="storage"} == 0
        for: 1m

      - alert: CacheMissRate
        expr: cache_miss_rate > 0.5
        for: 10m

      - alert: RemoteProviderTimeout
        expr: rate(remote_provider_timeouts[5m]) > 1
        for: 5m
```

## 安全最佳实践

### API Key 管理

```bash
# 使用强加密的 API Key
API_KEY=$(openssl rand -hex 32)

# 定期轮换 API Key（每 3 个月）
# 1. 生成新 key
NEW_KEY=$(openssl rand -hex 32)

# 2. 添加到 API_KEYS 列表
API_KEYS=old-key,new-key

# 3. 更新应用配置
# 4. 等待客户端更新
# 5. 移除旧 key
API_KEYS=new-key
```

### 网络隔离

```yaml
# 仅存储服务处于内部网络
networks:
  internal:
    internal: true  # 无法外部访问

  external:
    # MCP 服务可外部访问
```

### SSL/TLS 证书

```bash
# 使用 Let's Encrypt
certbot certonly --standalone -d api.example.com

# 设置自动续期
certbot renew --quiet --no-self-upgrade --post-hook \
  "docker-compose -f docker-compose.production.yml restart nginx"
```

## 性能优化

### 数据库优化

```sql
-- 添加必要的索引
CREATE INDEX idx_skills_slug ON skills(slug);
CREATE INDEX idx_skills_status ON skills(status);
CREATE INDEX idx_skill_files_skill_id ON skill_files(skill_id);
```

### 缓存优化

```bash
# 增加内存缓存大小（生产环境）
CACHE_MEMORY_MAX_SIZE=2000

# 启用文件缓存便于跨进程共享
CACHE_FILE_ENABLED=true
CACHE_FILE_DIR=/var/cache/skill-mcp
```

### OSS 优化

```bash
# 使用 CDN 加速
STORAGE_USE_CDN=true
STORAGE_CDN_DOMAIN=cdn.example.com

# 启用对象压缩
STORAGE_ENABLE_COMPRESSION=true
```

## 备份和恢复

### 自动备份

```bash
#!/bin/bash
# backup.sh

BACKUP_DIR=/backups/skill-mcp
DATE=$(date +%Y%m%d_%H%M%S)

# 备份数据库
docker-compose exec storage sqlite3 /data/skill-mcp.db \
  .dump > $BACKUP_DIR/db_$DATE.sql

# 备份到 S3
aws s3 cp $BACKUP_DIR/db_$DATE.sql \
  s3://backup-bucket/skill-mcp/

# 保留最近 30 天的备份
find $BACKUP_DIR -name "*.sql" -mtime +30 -delete
```

在 crontab 中设置定时备份：

```bash
# 每天凌晨 2 点备份
0 2 * * * /path/to/backup.sh >> /var/log/backup.log 2>&1
```

### 恢复过程

```bash
# 1. 停止服务
docker-compose -f docker-compose.production.yml down

# 2. 恢复数据库
sqlite3 /data/skill-mcp.db < backup_file.sql

# 3. 启动服务
docker-compose -f docker-compose.production.yml up -d

# 4. 验证
docker-compose -f docker-compose.production.yml exec storage \
  sqlite3 /data/skill-mcp.db "SELECT COUNT(*) FROM skills;"
```

## 故障排查

### 存储服务不可用

```bash
# 1. 检查日志
docker-compose logs storage

# 2. 检查健康状态
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:3000/api/gateway/health

# 3. 验证数据库
docker-compose exec storage \
  sqlite3 /data/skill-mcp.db ".tables"

# 4. 如需恢复，使用备份重启
```

### MCP 服务响应缓慢

```bash
# 1. 检查 cache 命中率
docker logs $(docker-compose ps -q mcp-1) | grep "Cache"

# 2. 清除缓存
docker-compose exec mcp-1 rm -rf /data/cache/*

# 3. 检查存储延迟
docker logs $(docker-compose ps -q storage) | grep latency

# 4. 考虑扩展 MCP 实例
docker-compose up -d --scale mcp=3
```

## 维护窗口

### 无停机更新

```bash
# 1. 构建新镜像
docker build -t skill-mcp:v2.0 .

# 2. 更新一个 MCP 实例
docker-compose -f docker-compose.production.yml up -d \
  --no-deps --build mcp-1

# 3. 健康检查
curl http://localhost/health

# 4. 更新其他实例
docker-compose -f docker-compose.production.yml up -d \
  --no-deps --build mcp-2

# 5. 更新存储（可能需要短暂停机）
docker-compose -f docker-compose.production.yml up -d \
  --no-deps --build storage
```

## 成本优化

### 资源配置

```yaml
# 生产环境资源限制
services:
  storage:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
        reservations:
          cpus: '1'
          memory: 2G

  mcp-1:
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 2G
        reservations:
          cpus: '0.5'
          memory: 1G
```

### 自动扩展

```bash
# 使用 Docker Swarm 或 Kubernetes 实现自动扩展
# 基于 CPU 和内存使用率自动调整实例数

# Kubernetes HPA 示例
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: mcp-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: mcp
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

## 检查清单

部署前验证：

- [ ] SSL/TLS 证书已配置
- [ ] 数据库备份已设置
- [ ] 监控和告警已启用
- [ ] 日志收集已配置
- [ ] API Key 已安全存储
- [ ] 负载均衡器已配置
- [ ] 健康检查已验证
- [ ] 性能测试已完成
- [ ] 文档已更新
- [ ] 团队已培训

## 进一步阅读

- [ARCHITECTURE.md](./ARCHITECTURE.md) - 架构详解
- [TESTING_GUIDE.md](./TESTING_GUIDE.md) - 测试指南
- [SCENARIO_C.md](./SCENARIO_C.md) - C2 分布式部署详解
