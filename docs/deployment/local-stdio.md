# 部署：本地 stdio（场景 A）

stdio MCP + 本地 SQLite + local-fs。适合个人 IDE / Agent、本地开发测试。

## 快速启动

```bash
cd /path/to/skill-mcp
npm install
npm run build

# 初始化（首次必须）：创建超级管理员并打印 bearer token
npx skill-mcp init --username admin --password <password>

# 启动 stdio MCP（init 后存在活跃用户，需 --auth-token）
npx skill-mcp serve --auth-token <token>
```

启动日志含 `Starting local Skill MCP Registry`。

> 数据默认位于 `~/.skill-mcp/`（DB `~/.skill-mcp/skill-mcp.db`、技能 `~/.skill-mcp/data/skills`、缓存 `~/.skill-mcp/cache`）。可用 `DATABASE_PATH` / `STORAGE_BASE_PATH` / `CACHE_FILE_DIR` 覆盖。

## 接入 Claude IDE

MCP 配置（`~/.claude/mcp.json` 或项目根）：

```json
{
  "mcpServers": {
    "skill-mcp": {
      "command": "npx",
      "args": ["skill-mcp", "serve", "--auth-token", "<token>"],
      "cwd": "/path/to/skill-mcp"
    }
  }
}
```

连接后可见 5 个工具：`skill_list`、`skill_search`、`skill_view`、`skill_file`、`skill_feedback`。

## 导入技能

```bash
# 本地目录
npx skill-mcp import /path/to/skill/dir

# Git 仓库
npx skill-mcp import https://github.com/user/skill-repo.git

# 查看（DB 在 ~/.skill-mcp/skill-mcp.db）
sqlite3 ~/.skill-mcp/skill-mcp.db "SELECT slug, name FROM skills"
```

### 手动创建测试技能

```bash
mkdir -p ~/.skill-mcp/data/skills/my-test-skill
cat > ~/.skill-mcp/data/skills/my-test-skill/SKILL.md << 'EOF'
---
name: my-test-skill
version: 0.0.1
description: A test skill
---
# My Test Skill

Use this skill to test the MCP server.
EOF

npx skill-mcp import ~/.skill-mcp/data/skills/my-test-skill
```

## 数据存储位置

```
~/.skill-mcp/
├── skill-mcp.db              # SQLite 元数据
├── data/skills/              # 技能文件
└── cache/                    # L2 文件缓存
```

## 常见问题

### 如何查看导入的技能
```bash
sqlite3 ~/.skill-mcp/skill-mcp.db "SELECT id, slug, name, status FROM skills"
ls -la ~/.skill-mcp/data/skills/
```

### 如何清除数据重新开始
```bash
rm -rf ~/.skill-mcp/
npx skill-mcp init --username admin --password <password>
```

### 日志级别
```bash
LOG_LEVEL=debug npx skill-mcp serve --auth-token <token>
```

### 缓存
- L1（内存 LRU）+ L2（文件），TTL 600s。
```bash
rm -rf ~/.skill-mcp/cache/   # 清 L2；重启清 L1
```

### 备份
```bash
cp ~/.skill-mcp/skill-mcp.db ~/.skill-mcp/skill-mcp.db.backup
tar -czf skill-backup.tar.gz -C ~/.skill-mcp data/skills
```

## 下一步

- [单机 HTTP（C1）](./single-http.md)
- [项目文档](../../README.md)
