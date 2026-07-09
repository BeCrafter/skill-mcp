# 场景 A：本地独立模式

快速启动 - stdio MCP + 本地文件存储

## 概述

场景 A 是最简单的部署方式，适合：
- 本地开发和测试
- 单用户使用
- 无需网络通信
- 快速原型验证

## 快速启动

### 1. 准备环境

```bash
# 克隆或进入项目目录
cd /path/to/skill-mcp

# 安装依赖
npm install

# 编译项目
npm run build
```

### 2. 启动本地 MCP

```bash
# 使用默认配置（stdio transport，全功能模式）
npm start

# 或显式指定
TRANSPORT_TYPE=stdio npm start

# 或使用配置文件
cp src/config/examples/.env.scenario-a .env.local
npm start
```

### 3. 验证启动成功

启动后，应该看到以下日志：

```
[INFO] Stdio transport configured
[INFO] SkillService initialized
```

如果看到这些信息，说明 MCP 服务器已成功启动。

## 使用 Claude IDE

### 方法 1：通过 CLI 集成

如果你的系统已安装 Claude Code CLI：

```bash
# 启动 MCP 服务器后，在另一个终端中
claude-code --transport stdio /path/to/skill-mcp/npm start
```

### 方法 2：通过 MCP 配置文件

1. 创建 MCP 配置文件 (通常在 `~/.claude/mcp.json` 或项目根目录)

```json
{
  "mcpServers": {
    "skill-mcp": {
      "command": "npm",
      "args": ["start"],
      "cwd": "/path/to/skill-mcp",
      "env": {
        "TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

2. 在 Claude IDE 中配置 MCP 连接

3. 连接后应该能看到 skill_list、skill_view、skill_file、skill_search、skill_feedback、skill_pipeline 六个工具

## 导入示例技能

### 使用 CLI 导入

```bash
# 从本地目录导入
npm run import -- /path/to/skill/dir

# 从 Git 仓库导入
npm run import -- https://github.com/user/skill-repo.git

# 导入后查看
sqlite3 data/skill-mcp.db "SELECT slug, name FROM skills"
```

### 手动创建测试技能

1. 创建技能目录

```bash
mkdir -p ./data/skills/my-test-skill
```

2. 创建 SKILL.md（包含 frontmatter 元数据）

```bash
cat > ./data/skills/my-test-skill/SKILL.md << 'EOF'
---
name: my-test-skill
version: 0.0.1
description: A test skill
---
# My Test Skill

This is a test skill for scenario A.

## Usage

Use this skill to test the MCP server.

## Features

- Feature 1
- Feature 2
- Feature 3
EOF
```

3. 导入到数据库

```bash
npm run import -- ./data/skills/my-test-skill
```

## 测试 MCP 工具

启动 MCP 后，可以测试以下工具：

### 1. skill_list - 列表所有技能

```typescript
// 调用结果
{
  "skills": [
    {
      "id": "uuid-here",
      "slug": "my-test-skill",
      "name": "my-test-skill",
      "description": "A test skill",
      "version": "0.0.1"
    }
  ]
}
```

### 2. skill_view - 查看技能详情

```typescript
// 输入：my-test-skill
// 输出：完整的 SKILL.md 内容
```

### 3. skill_file - 读取特定文件

```typescript
// 输入：
// - skillId: my-test-skill
// - paths: ["templates/basic.md", "SKILL.md"]
// 输出：文件内容列表
```

## 数据存储位置

所有本地数据存储在 `./data` 目录：

```
./data/
├── skill-mcp.db              # SQLite 数据库（元数据）
├── skills/                   # 技能文件存储
│   └── my-test-skill/
│       └── SKILL.md
└── cache/                    # L2 文件缓存
    └── *.json
```

## 常见问题

### Q: 如何查看导入的技能？

```bash
# 查看数据库
sqlite3 data/skill-mcp.db "SELECT id, slug, name, status FROM skills"

# 查看文件系统
ls -la ./data/skills/
```

### Q: 如何清除数据重新开始？

```bash
# 删除数据目录
rm -rf ./data/

# 重新启动，会自动创建新的数据库
npm start
```

### Q: 如何查看日志？

默认日志在控制台输出。日志级别通过环境变量控制：

```bash
# 启用调试日志
LOG_LEVEL=debug npm start

# 只显示错误
LOG_LEVEL=error npm start
```

### Q: 缓存如何工作？

- L1 缓存（内存）：进程内存中，快速但有限制
- L2 缓存（文件）：磁盘上，持久化但较慢

缓存 TTL：600 秒（10 分钟）

```bash
# 清除文件缓存
rm -rf ./data/cache/

# 重启进程清除内存缓存
npm start
```

### Q: 如何备份技能？

```bash
# 备份数据库
cp ./data/skill-mcp.db ./data/skill-mcp.db.backup

# 备份所有文件
tar -czf skill-backup.tar.gz ./data/skills/
```

## 下一步

- 了解 [Scenario B（混合部署）](./SCENARIO_B.md)
- 了解 [Scenario C（分布式部署）](./SCENARIO_C.md)
- 完整 [架构文档](./ARCHITECTURE.md)

## 支持

如有问题，请查看：
1. 项目的 GitHub Issues
2. 完整架构文档中的故障排查部分
3. 日志输出（通常很有帮助）
