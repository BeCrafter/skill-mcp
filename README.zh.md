# Skill MCP Server

**云技能文件系统与 MCP 权限网关**

一个为 AI 助手提供托管技能文件系统的模型上下文协议 (MCP) 服务器。通过标准 MCP 工具导入、版本化和服务可重用技能包，内置安全扫描、RBAC 和流程编排功能。

## 功能特性

- **MCP 协议** — 将技能作为 MCP 工具暴露，兼容任何 MCP 客户端
- **多传输方式** — 支持 stdio、SSE 和可流式 HTTP 传输
- **流程编排引擎** — 基于 DAG 的技能编排，支持并行执行
- **RBAC** — 基于标签的基于角色的访问控制
- **技能反馈** — 收集技能效果反馈，以数据驱动改进
- **技能导入** — 从本地目录或 Git 仓库导入技能包
- **安全扫描** — 对所有导入的技能内容进行内置提示词注入检测
- **版本管理** — 自动语义版本控制，基于内容哈希跟踪和回滚支持
- **缓存** — 分层内存（LRU）+ 文件缓存，实现快速技能检索
- **SQLite 存储** — 通过 Drizzle ORM + better-sqlite3 持久化元数据
- **CLI 管理** — 完整的命令行界面，用于导入、列出、搜索和管理技能

## 📚 文档导航

### 针对不同角色

**👨‍💻 新手开发者**
1. 从 [快速开始](./docs/QUICK_START.md) 开始（5 分钟）
2. 阅读 [贡献指南](./CONTRIBUTING.md)（开发流程）
3. 查看 [Claude Code 指南](./CLAUDE.md)（IDE 设置）

**🚀 DevOps / 部署**
- [生产部署](./docs/PRODUCTION_DEPLOYMENT.md) — 生产环境设置
- [场景](./docs/SCENARIOS/) — 不同的部署模式 (A/B/C)

**🏗️ 架构师 / 维护者**
- [架构概览](./docs/ARCHITECTURE.md) — 系统设计
- [组织规则](./docs/ORGANIZATION.md) — 代码结构
- [API 参考](./docs/API_REFERENCE.md) — MCP 工具 & REST API
- [高级主题](./docs/ADVANCED/) — 流程编排引擎、RBAC、技术规范

**🧪 QA / 测试**
- [测试指南](./docs/TESTING_GUIDE.md) — 如何运行测试

**📖 其他资源**
- [代码组织分析](./docs.local/CODE_ORGANIZATION_ANALYSIS.md) — 代码库结构分析

## 前置要求

- Node.js >= 22.0.0

## 安装

```bash
npm install
npm run build
```

## 📋 选择您的部署场景

本项目支持 **三种灵活的部署模式**：

| 场景 | 传输方式 | 存储 | 用途 |
|----------|-----------|---------|----------|
| **A** - 本地 | stdio | 本地 | 开发、单用户 |
| **B** - 混合 | stdio | 远程 | 本地 MCP + 共享存储 |
| **C** - 分布式 | HTTP | 本地/远程 | 生产、多客户端 |

👉 **[快速开始指南 →](./docs/QUICK_START.md)**

- **场景 A** - [本地开发](./docs/SCENARIOS/SCENARIO_A.md)
- **场景 B** - [混合部署](./docs/SCENARIOS/SCENARIO_B.md)
- **场景 C** - [分布式部署](./docs/SCENARIOS/SCENARIO_C.md)
- **完整架构** - [完整参考](./docs/ARCHITECTURE.md)

## 快速开始

### 1. 启动 MCP 服务器

```bash
# 场景 A: 本地 stdio（推荐用于开发）
npm start

# 场景 C: HTTP 服务器（生产环境）
TRANSPORT_TYPE=http npm start

# 网关模式：代理到远程云服务
DEPLOYMENT_MODE=gateway CLOUD_SERVICE_URL=http://cloud-service:3001 npm start
```

### 2. 导入技能

```bash
# 从本地目录导入
npx skill-mcp import ./path/to/skill-package

# 从 Git 仓库导入
npx skill-mcp import https://github.com/org/skill-repo --branch main

# 带元数据导入
npx skill-mcp import ./my-skill --category "writing" --tags "prompt,creative"
```

### 3. 管理技能

```bash
# 列出所有技能
npx skill-mcp list

# 查看技能详情
npx skill-mcp info prompt-writer

# 搜索技能
npx skill-mcp search --name prompt

# 更新元数据
npx skill-mcp update prompt-writer --category "productivity" --display-name "Prompt Writer Pro"

# 查看版本历史
npx skill-mcp versions prompt-writer

# 回滚到之前的版本
npx skill-mcp rollback prompt-writer --to 0.0.1

# 删除技能
npx skill-mcp remove old-skill --force
```

### 4. 流程编排

```bash
# 验证流程 YAML
npx skill-mcp pipeline validate ./pipeline.yaml

# 可视化流程 DAG
npx skill-mcp pipeline graph ./pipeline.yaml

# 执行流程（试运行）
npx skill-mcp pipeline run ./pipeline.yaml --input pr_url=https://... --dry-run
```

### 5. RBAC 管理

```bash
# 创建角色
npx skill-mcp role create --name "data-team" --tags "data,analysis" --description "数据科学团队"

# 创建用户
npx skill-mcp user create --name "Alice" --role-ids "role-uuid-1,role-uuid-2"

# 列出用户
npx skill-mcp user list

# 分配角色
npx skill-mcp user assign-roles user-id-1 --role-ids "role-uuid-1"
```

### 6. 技能检查

```bash
# 检查技能包目录
npx skill-mcp lint ./path/to/skill-package
```

## MCP 工具

| 工具 | 描述 |
|------|-------------|
| `skill_list` | 列出所有已发布的技能，支持可选过滤 |
| `skill_view` | 查看特定技能的完整条目内容 |
| `skill_file` | 从技能包读取单个文件 |
| `skill_pipeline` | 执行流程（技能的 DAG 编排） |
| `skill_feedback` | 提交技能效果反馈 |

## 配置

配置从环境变量或 `skill-mcp.config.json` 文件加载（自动检测）。所有字段都有合理的默认值：

```jsonc
{
  "app": {
    "name": "skill-mcp",
    "env": "production",           // "development" | "production" | "test"
    "version": "0.0.1"
  },
  "deployment": {
    "mode": "standalone"          // "standalone" | "gateway" | "cloud"
  },
  "gateway": {                   // 仅用于网关模式
    "cloudServiceUrl": "http://cloud-service:3001",
    "authToken": "your-token"
  },
  "storage": {
    "type": "local-fs",         // 目前仅支持 "local-fs"
    "basePath": "./data/skills"
  },
  "database": {
    "path": "./data/skill-mcp.db"
  },
  "cache": {
    "memory": { "enabled": true, "maxSize": 500 },
    "file": { "enabled": true, "cacheDir": "./data/cache" }
  },
  "transport": {
    "type": "stdio",              // "stdio" | "sse" | "http"
    "port": 3000,
    "host": "0.0.0.0",
    "mcpOnlyMode": false         // 如果为 true，禁用 /api/admin/* 路由
  },
  "security": {
    "enableInjectionScan": true
  },
  "apiKey": {                    // 可选的 API 密钥认证
    "enabled": false,
    "keys": []
  }
}
```

### 环境变量

| 变量 | 描述 | 默认值 |
|----------|-------------|---------|
| `NODE_ENV` | 环境 | `development` |
| `DEPLOYMENT_MODE` | 部署模式 | `standalone` |
| `STORAGE_TYPE` | 存储后端 | `local-fs` |
| `STORAGE_BASE_PATH` | 技能目录 | `./data/skills` |
| `DATABASE_PATH` | SQLite 数据库路径 | `./data/skill-mcp.db` |
| `TRANSPORT_TYPE` | 传输类型 | `stdio` |
| `TRANSPORT_PORT` | HTTP 端口 | `3000` |
| `TRANSPORT_HOST` | HTTP 主机 | `0.0.0.0` |
| `CLOUD_SERVICE_URL` | 云服务 URL（网关） | - |
| `AUTH_TOKEN` | 认证令牌（网关） | - |
| `LOG_LEVEL` | 日志级别 | `info` |
| `API_KEY_AUTH_ENABLED` | 启用 API 密钥认证 | `false` |
| `API_KEYS` | 有效的 API 密钥（逗号分隔） | - |

## 技能包格式

技能包是一个包含以下内容的目录：

```
my-skill/
├── manifest.json     # 包元数据（name, version, entry）
├── SKILL.md          # 主要技能内容（默认入口点）
├── references/       # 支持参考文件
│   └── examples.md
└── templates/        # 模板文件
    └── checklist.md
```

### manifest.json

```json
{
  "name": "my-skill",
  "version": "0.0.1",
  "entry": "SKILL.md",
  "files": ["references/examples.md"]
}
```

## 流程格式

流程是一个定义技能阶段 DAG（有向无环图）的 YAML 文件：

```yaml
name: code-review-pipeline
description: 带安全检查和风格检查的自动化代码审查

inputs:
  pr_url:
    type: string
    required: true

stages:
  read-pr:
    skill: github-pr-reader
    inputs:
      url: ${{ inputs.pr_url }}
    outputs: [diff, files]

  security-scan:
    skill: security-scanner
    depends_on: [read-pr]
    inputs:
      code: ${{ stages.read-pr.outputs.diff }}
    outputs: [vulnerabilities]

  style-check:
    skill: style-checker
    depends_on: [read-pr]
    inputs:
      files: ${{ stages.read-pr.outputs.files }}
    outputs: [violations]

  generate-report:
    skill: report-writer
    depends_on: [security-scan, style-check]
    inputs:
      security: ${{ stages.security-scan.outputs }}
      style: ${{ stages.style-check.outputs }}
    outputs: [report]

output:
  report: ${{ stages.generate-report.outputs.report }}
```

## 项目结构

```
src/
├── cli/              # CLI 命令（import, list, serve, pipeline, user, role 等）
├── config/           # 配置模式和加载器
├── mcp/              # MCP 服务器、工具和传输
│   └── tools/        # MCP 工具实现
├── services/         # 业务逻辑（skill 服务、访问日志）
├── provider/         # 数据提供者（local, remote）
├── pipeline/         # 流程引擎（DAG, executor, parser）
├── permission/       # 权限过滤器和 RBAC
├── storage/          # 存储提供者（local FS）
├── cache/            # 缓存提供者（memory LRU, file, composite）
├── db/               # 数据库模式、迁移、仓库
├── import/           # 技能导入流程（validator, sources）
├── prompt/           # 系统提示词构建器
├── admin/            # 管理 API 路由
├── http/             # HTTP 服务器和中间件
├── events/           # 事件系统
├── telemetry/        # 指标和监控
├── middleware/       # 请求中间件
├── types/            # TypeScript 类型定义
└── utils/            # 共享工具（security, errors, manifest）
```

## CLI 命令参考

| 命令 | 描述 |
|---------|-------------|
| `serve` | 启动 MCP 服务器 |
| `import <source>` | 从本地路径或 Git 仓库导入技能 |
| `list` | 列出所有技能 |
| `info <slug>` | 显示技能详情 |
| `search --name <name>` | 按名称搜索技能 |
| `update <slug>` | 更新技能元数据 |
| `remove <slug>` | 删除技能 |
| `versions <slug>` | 显示版本历史 |
| `rollback <slug>` | 回滚到之前的版本 |
| `lint <path>` | 检查技能包 |
| `pipeline validate` | 验证流程 YAML |
| `pipeline graph` | 可视化流程 DAG |
| `pipeline run` | 执行流程 |
| `user list/create/get/delete/assign-roles` | 管理用户 |
| `role list/create/get/update/delete` | 管理角色 |

## 脚本

| 命令 | 描述 |
|---------|-------------|
| `npm run build` | 将 TypeScript 编译到 `dist/` |
| `npm run dev` | 监视模式编译 |
| `npm start` | 运行服务器 |
| `npm test` | 使用 Vitest 运行测试 |
| `npm run test:watch` | 以监视模式运行测试 |
| `npm run test:coverage` | 生成覆盖率报告 |
| `npm run lint` | 检查源文件 |
| `npm run lint:fix` | 检查并自动修复 |
| `npm run db:migrate` | 运行数据库迁移 |

## 测试

测试使用 Vitest 编写，位于 `tests/` 中：

```
tests/
└── unit/
    ├── utils/           # 安全扫描、验证、错误处理
    ├── cache/           # LRU 缓存提供者
    ├── prompt/          # 系统提示词生成
    └── import/          # 包验证
```

```bash
# 运行所有测试
npm test

# 运行覆盖率
npm run test:coverage

# 监视模式
npm run test:watch
```

## RBAC 概述

服务器实现了基于 **标签** 的灵活 RBAC 系统：

- **标签**：分配给技能的能力标签（`skills.tags`）
- **角色**：授予访问权限的标签集合
- **用户**：分配给角色的平台用户

**权限规则**：
- `skill.tags = []` → 公开技能，所有人可访问
- `skill.tags ∩ user.tags ≠ ∅` → 受保护技能，用户拥有匹配标签时可访问
- `skill.tags ∩ user.tags = ∅` → 受限技能，不可访问

## 安全性

- **提示词注入扫描** — 所有导入的技能内容都会扫描已知的注入模式
- **路径遍历保护** — 文件路径验证防止目录遍历攻击
- **文件类型安全** — 拒绝二进制文件；仅允许基于文本的格式
- **API 密钥认证** — 管理 API 路由的可选 API 密钥认证

## 许可证

MIT

---

# 📦 发布指南

## 发布流程

项目使用自动化流程进行发布，确保每次发布都经过完整的测试和验证。

### 流程概览

```
main 分支更新
    ↓
自动创建 Release PR
    ↓
审查并合并 Release PR
    ↓
自动创建 Git Tag
    ↓
触发发布 Workflow
    ↓
发布到 npm
    ↓
自动创建 GitHub Release
```

### 触发方式

#### 方式一：自动触发（推荐）

1. 将代码合并到 `main` 分支
2. GitHub Actions 自动创建 Release PR
3. 审查并合并 Release PR
4. 自动触发发布流程

#### 方式二：手动触发

1. 更新 `package.json` 中的版本号
2. 创建并推送 Git tag：
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
3. GitHub Actions 自动触发发布流程

#### 方式三：使用 npm scripts

```bash
# 发布补丁版本 (1.0.0 → 1.0.1)
npm run release:patch

# 发布次版本 (1.0.0 → 1.1.0)
npm run release:minor

# 发布主版本 (1.0.0 → 2.0.0)
npm run release:major

# 发布预发布版本
npm run release:alpha  # Alpha 测试版
npm run release:beta   # Beta 测试版
npm run release:rc     # RC 候选发布版
npm run release:dev    # Dev 开发版本
```

### 版本号规则

项目遵循 [Semantic Versioning](https://semver.org/) 规范：

- **主版本号 (MAJOR)**：不兼容的 API 变更
- **次版本号 (MINOR)**：向下兼容的功能新增
- **修订号 (PATCH)**：向下兼容的问题修正

### 版本类型与 npm 标签

| 版本类型 | Git Tag | npm dist-tag | GitHub Release |
|---------|----------|-------------|----------------|
| 正式版 | v1.0.0 | latest | 是 |
| RC 版 | v1.0.0-rc.1 | rc | 是 |
| Beta 版 | v1.0.0-beta.1 | beta | 否 |
| Alpha 版 | v1.0.0-alpha.1 | alpha | 否 |
| Dev 版 | v1.0.0-dev.1 | dev | 否 |

### 发布前检查

在发布前，请确保：

- [ ] 所有测试通过
- [ ] 代码已通过 ESLint 检查
- [ ] 文档已更新（README.md、README.zh.md）
- [ ] CHANGELOG.md 已更新
- [ ] 没有破坏性变更或已文档化

详细说明请参考 [发布指南](./docs/PUBLISHING.md)。

## GitHub Actions 工作流

### 1. CI Workflow (ci.yml)

在每个 PR 和 push 时运行，确保代码质量：

- 运行 ESLint
- TypeScript 编译
- 运行测试
- 生成覆盖率报告

### 2. Publish Workflow (publish.yml)

在创建 Git tag 时触发，执行发布：

- 运行完整的 CI 检查
- 验证版本号匹配
- 发布到 npm
- 创建 GitHub Release

### 3. Release PR Workflow (release-pr.yml)

在推送到 `main` 分支时自动创建 Release PR。

### 4. Create Tag Workflow (create-tag.yml)

在合并 Release PR 后自动创建 Git tag。

## 配置

### npm Token 配置

在 GitHub repository settings 中配置：

1. 进入 Settings → Secrets and variables → Actions
2. 添加新的 Secret：
   - Name: `NPM_TOKEN`
   - Value: Your npm automation token

### 获取 npm Token

1. 访问 https://www.npmjs.com/settings/tokens
2. 点击 "Create New Token"
3. 选择 "Automation" 类型
4. 复制生成的 token
5. 添加到 GitHub Secrets

## 发布后验证

发布完成后，验证以下内容：

1. **npm registry**
   - 访问 https://www.npmjs.com/package/skill-mcp-server
   - 确认版本号和发布时间正确

2. **GitHub Release**
   - 访问 repository 的 Releases 页面
   - 确认 Release 说明正确

3. **安装测试**
   ```bash
   npm install -g skill-mcp-server@<version>
   skill-mcp --help
   ```

## 回滚

如果发现问题需要回滚：

```bash
# 撤销 npm 发布（72 小时内）
npm unpublish skill-mcp-server@<version> --force

# 或发布新版本修复
npm run release:patch
```

**注意**：npm 只允许在发布后 72 小时内撤销，超过时间需要发布新版本修复。

## 故障排除

### 发布失败

检查以下内容：

1. npm token 是否正确配置
2. package.json 中的版本号是否与 tag 一致
3. CI 测试是否全部通过
4. 是否有文件冲突或权限问题

查看 GitHub Actions 日志获取详细错误信息。

### 版本号不匹配

错误信息：
```
❌ Version mismatch!
package.json version: 1.0.0
Git tag version: 1.0.1
```

解决方法：
- 更新 package.json 中的版本号
- 或删除并重新创建正确的 tag

### npm 认证失败

确保：
- npm token 使用 "Automation" 类型
- token 已添加到 GitHub Secrets
- token 没有过期

## 相关文档

- [Semantic Versioning](https://semver.org/)
- [npm publish](https://docs.npmjs.com/cli/v9/commands/npm-publish)
- [GitHub Actions](https://docs.github.com/en/actions)
