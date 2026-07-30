# skill-mcp 文档

文档导航与索引。

**命名约定**：内容文档用 lowercase-kebab（如 `permission-control.md`）；版本文件如 `v0.1.md`；目录索引为 `README.md`。

## 快速上手

- [README](../README.md) — 项目总览、快速开始、环境变量
- [CLI 指南](./cli/guide.md) — 命令行完整使用参考
- [部署](./deployment/README.md) — 部署形态选型与操作

## 部署

- [部署总览](./deployment/README.md) — 选型矩阵、模式开关
- [本地 stdio](./deployment/local-stdio.md) — 个人 IDE / Agent
- [单机 HTTP（C1）](./deployment/single-http.md) — 开发/测试
- [分布式（C2）](./deployment/distributed-c2.md) — 生产，storage + MCP 代理 + 网关
- [API-only 后端](./deployment/api-only-backend.md) — REST 管理自动化 / C2 的 storage
- [Docker 配置](../docker/README.md) — Dockerfile、Compose、Caddyfile

## 版本与发布

- [发布索引](./releases/README.md) — 当前实现版本与版本清单
- [v0.1 范围契约](./releases/v0.1.md) — 保留/移除能力、搜索契约、DB 兼容性、验收
- [发布指南](./releases/publishing.md) — npm 发布、版本号、CI、回滚

## 架构与开发

- [架构（SSOT）](./ARCHITECTURE.md) — 分层、模块清单、关键流程、已知问题、路线图（CLAUDE.md 强制引用）
- [重构待办](./refactoring-backlog.md) — T-XXX 优化积压清单（历史，按 v0.1 范围筛拣）
- [Licensing](./advanced/licensing.md) — MIT 授权策略
- [技术方案（已废弃）](./advanced/tech-dev-program.md) — pre-v0.1 设计，已被 ARCHITECTURE.md 取代

## 权威规范

- [权限管控](./permission-control.md) — RBAC 矩阵、用户/角色、守卫（**权限变更的唯一权威**）
