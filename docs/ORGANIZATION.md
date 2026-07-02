# 项目文件组织规范

本文档定义了 skill-mcp 项目的文件管理标准，确保清晰的组织结构和一致的实践。

## 应该提交到 Git 的文件 ✅

### 源代码
- `src/` - 完整的源代码
- `tests/` - 测试文件和测试框架

### 文档
- `docs/` - 所有项目文档
- `README.md` - 项目入口（根目录唯一的 .md 文件）
- `CLAUDE.md` - Claude Code 配置和指导
- `ORGANIZATION.md` - 本文件，文件管理规范

### 配置文件
- `package.json` - Node.js 项目配置
- `package-lock.json` - 依赖锁定文件（npm，唯一的lock文件）
- `tsconfig.json` - TypeScript 配置
- `vitest.config.ts` - 测试框架配置
- `eslint.config.js` - 代码检查配置
- `.gitignore` - Git 忽略规则

### 其他
- `.git/` - Git 仓库历史
- `.github/` - GitHub 配置（如果使用）

---

## 不应该提交的文件 ❌

### 依赖目录
- `node_modules/` - 从 package.json 恢复，使用 `npm install`
- 第三方依赖和包

### 编译产物
- `dist/` - TypeScript 编译输出
- `serve`, `import`, `list` - CLI 编译脚本
- `build/` - 构建输出

### 运行时数据
- `data/` - **重要**：本地数据库、技能文件、缓存
  - SQLite 数据库文件 (`*.db`, `*.db-shm`, `*.db-wal`)
  - 生成的技能文件
  - 运行时缓存文件
  - 这些文件在开发时本地生成，生产环境应外部挂载或初始化

### 环境和密钥
- `.env` - 本地环境变量（永远不要提交）
- `.env.local` - 本地覆盖（永远不要提交）
- 使用 `.env.example` 作为模板

### 缓存和临时文件
- `*.tsbuildinfo` - TypeScript 增量构建缓存
- `.cache/`, `.parcel-cache/` - 各种构建缓存
- `__pycache__/`, `*.pyc` - Python 编译缓存
- `node_modules/.cache/` - npm 缓存

### IDE 和编辑器配置
- `.vscode/` - VS Code 工作区设置
- `.idea/` - IntelliJ IDE 配置
- `*.swp`, `*.swo` - Vim 临时文件
- `.DS_Store` - macOS 系统文件

### 日志和调试文件
- `*.log` - 应用日志
- `npm-debug.log*` - npm 调试日志
- `coverage/` - 测试覆盖率报告

### 包管理配置
- `pnpm-lock.yaml` - 不使用，保持 npm 一致性
- 其他包管理器的锁定文件

---

## 文档组织结构

```
docs/
├── README.md                        # 文档入口和导航
├── QUICK_START.md                   # 快速开始指南
├── ARCHITECTURE.md                  # 系统架构概览
├── API_REFERENCE.md                 # MCP 工具和 Gateway API
├── TESTING_GUIDE.md                 # 测试框架和运行方法
├── PRODUCTION_DEPLOYMENT.md         # 生产部署指南
├── PUBLISHING.md                    # 发布和版本管理指南
│
├── SCENARIOS/                       # 部署场景文档
│   ├── SCENARIO_A.md               # 本地 stdio 开发
│   ├── SCENARIO_B.md               # 混合 Gateway + 本地
│   └── SCENARIO_C.md               # 分布式 HTTP 部署
│
├── ADVANCED/                        # 高级主题
│   ├── LICENSING.md                # OSS/商业许可策略
│   └── tech-dev-program.md         # 原始技术方案 PRD（2026-04）
│
```

### 文档命名规范

- 一般文档：`UPPER_CASE_WITH_UNDERSCORES.md` 或 `Title Case.md`
- 审查和报告：`YYYY-MM-DD-report-name.md` （添加日期前缀）
- 内容类文档应清晰说明用途

---

## 新增文档的实践

### 何时创建文档

✅ 创建文档用于：
- 架构或设计决策
- 部署指南
- API 规范
- 测试和开发工具指南
- 性能优化指南

❌ 不创建：
- 一次性的变更日志（使用 Git 提交消息）
- 实现过程中的临时笔记
- 待办事项列表（使用 GitHub Issues）

### 文档位置规则

1. **快速开始和基础**：`docs/` 根目录
2. **部署相关**：`docs/SCENARIOS/` 或 `docs/PRODUCTION_DEPLOYMENT.md`
3. **高级主题**：`docs/ADVANCED/`
4. **永远不要**：在根目录创建 `*.md` 文件（除了 `README.md`）

### Pull Request 时的文档处理

- 如果修改现有文档，在 PR 描述中说明改进的地方
- 如果添加新文档，在 PR 中明确说明为什么以及放在哪里
- 避免在一个 PR 中混入多个不相关的文档变更

---

## 本地开发指南

### 初始化项目

```bash
# 克隆仓库
git clone <repo-url>
cd skill-mcp

# 安装依赖
npm install

# 构建项目
npm run build

# 运行测试
npm test
```

### 忽略 data/ 目录

`data/` 目录会自动创建和填充：

```bash
# 本地开发时
npm start  # 会创建 data/skill-mcp.db 和 data/cache/

# data/ 目录内容
data/
├── skill-mcp.db          # SQLite 数据库
├── skill-mcp.db-shm      # WAL 共享内存
├── skill-mcp.db-wal      # WAL 日志
├── cache/                # 运行时缓存
└── skills/               # 导入的技能文件
    ├── {skill-slug1}/    # 技能1，按 slug 组织
    │   ├── SKILL.md
    │   └── ...
    └── {skill-slug2}/    # 技能2，按 slug 组织
        ├── SKILL.md
        └── ...
```

### 技能存储路径约定

技能按照其 **slug**（而不是 name）进行组织，规则如下：

**物理存储路径**：`data/skills/{skill-slug}/`

**数据库记录**：`skills` 表的 `storage_path` 字段存储相对路径 `{skill-slug}/`

**示例**：
- 技能名称：`"Prompt Writer"`
- 生成的 slug：`"prompt-writer"`  
- 物理路径：`data/skills/prompt-writer/`
- 数据库记录：`storage_path = "prompt-writer/"`

**为什么使用 slug 而不是 name**：
- ✅ Slug 是确定性的（相同 name 总产生相同 slug）
- ✅ Slug 是 URL-safe 的（只包含小写字母、数字、连字符）
- ✅ 避免路径安全问题（特殊字符、空格等）
- ✅ 支持技能名称碰撞检测（系统会拒绝重复导入同名技能）

**技能名称碰撞处理**：
- 同名技能第一次导入 → 创建新技能
- 同名技能重复导入 → 拒绝（需使用 `--overwrite` 标记）
- 使用 `--overwrite` 导入 → 更新现有技能，版本号自动提升

### 清理本地文件

```bash
# 清理编译产物
rm -rf dist/

# 清理数据（仅本地开发）
rm -rf data/

# 重建一切
npm install && npm run build && npm test
```

---

## 大文件处理

### 规则

- 单个文件 > 1MB：需要评估是否真的必要
- 二进制文件（图片、视频）：考虑使用外部链接或文档引用
- 依赖文件：通过 package.json 管理，不直接提交

### 检查大文件

```bash
# 查找大于 1MB 的文件
find . -type f -size +1M ! -path "./node_modules/*" ! -path "./.git/*" ! -path "./dist/*"
```

---

## 常见问题

### Q: 能否提交 `data/` 目录？
**A**: 不能。`data/` 在 .gitignore 中。这是运行时生成的数据。生产环境应：
- 外部挂载数据目录
- 启动时初始化数据库
- 从备份恢复数据

### Q: `.env` 文件应该提交吗？
**A**: 不能。`.env` 包含敏感信息（API 密钥等）。使用 `.env.example` 作为模板。

### Q: 为什么同时有多个架构文档？
**A**: `ARCHITECTURE.md` 是唯一的架构文档（Single Source of Truth）。`ADVANCED/tech-dev-program.md` 是 2026-04 的原始 PRD，保留作为历史参考。

### Q: 能否删除旧的审查报告？
**A**: 历史审查报告已从项目中移除（2026-07 清理）。如有需要，请参考 CHANGELOG.md 中的变更记录。

---

## 维护此规范

此文档会随项目演进而更新。如有建议：

1. 在 PR 中提出问题
2. 引用此文档中相关部分
3. 说明为什么需要更改

---

**最后更新**: 2026-04-29  
**维护者**: Project Team
