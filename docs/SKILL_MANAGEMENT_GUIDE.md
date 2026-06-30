# 技能管理操作完整示例

本文档提供编译后（`npm run build`）的技能导入、管理、版本对比等操作的完整示例。

---

## 前置准备

```bash
# 编译项目
npm run build

# 初始化系统（创建超级管理员）
node dist/index.js init --username admin --password admin888

# 登录
node dist/index.js auth login
# 输入用户名: admin
# 输入密码: admin888
```

---

## 1. 技能导入 (import)

### 1.1 基本导入

```bash
# 从本地目录导入技能
node dist/index.js import ./my-skill

# 导入指定路径的技能
node dist/index.js import /path/to/skill-directory
```

### 1.2 导入选项

```bash
# 指定分类
node dist/index.js import ./my-skill --category writing

# 指定标签（逗号分隔）
node dist/index.js import ./my-skill --tags prompt,engineering

# 指定 slug（覆盖自动推断）
node dist/index.js import ./my-skill --slug my-custom-slug

# 覆盖已存在的技能
node dist/index.js import ./my-skill --overwrite

# 允许重复导入（不同 slug）
node dist/index.js import ./my-skill --allow-duplicate

# 指定版本号
node dist/index.js import ./my-skill --version-bump minor

# 从 Git 仓库导入
node dist/index.js import https://github.com/user/repo --branch main --sub-dir skills/my-skill
```

### 1.3 远程模式导入

```bash
# 导入到远程服务器
node dist/index.js import ./my-skill --server-url http://localhost:3000
```

---

## 2. 技能列表 (list)

### 2.1 查看所有技能

```bash
node dist/index.js list
```

输出示例：
```
  ── Skills (3) ────────────────────────────────────────────────────────────────────────

    SLUG                 VERSION     STATUS            TAGS                      DETAILS
    prompt-writer        v1.2.0      published         prompt, engineering       A skill for writing prompts
    code-reviewer ⎇      v0.3.1      published         review, code              Code review assistant
    data-analyst         v0.1.0      draft                                       Data analysis tool
```

> `⎈` 标记表示 Git 远程导入的技能，无标记表示本地导入

### 2.2 按标签过滤

```bash
node dist/index.js list --tags prompt
node dist/index.js list --tags prompt,engineering
```
---

## 3. 技能搜索 (search)

```bash
# 按名称搜索技能
node dist/index.js search --name prompt

# 搜索包含 "code" 的技能
node dist/index.js search --name code
```

输出示例：
```
  ── Results for "code" (2) ─────────────────────

    SLUG              VERSION   STATUS          DESCRIPTION
    code-reviewer ⎇   v0.3.1    published       Code review assistant
    code-generator    v1.0.0    published       Generate code snippets
```

---

## 4. 技能详情 (info)

```bash
# 查看技能详细信息
node dist/index.js info prompt-writer
```

输出示例：
```
  prompt-writer
  ─────────────────────────────────────────

    Version       v1.2.0
    Status        published
    Category      writing
    Tags          prompt, engineering
    Updated       2026-06-25 14:20:00

    Technical
    ────────────────────
    Entry         SKILL.md
    Storage       prompt-writer/
    Hash          sha256:a1b2c3d4e5f67890…
    Created       2026-06-20 10:30:00

  A skill for writing high-quality prompts with structured templates
  and best practices.
```
---

## 5. 技能更新 (update)

### 5.1 更新分类

```bash
node dist/index.js update prompt-writer --category ai-writing
```

### 5.2 更新标签

```bash
node dist/index.js update prompt-writer --tags prompt,ai,engineering
```

### 5.3 更新描述

```bash
node dist/index.js update prompt-writer --description "A comprehensive prompt writing skill"
```

### 5.4 更新显示名称

```bash
node dist/index.js update prompt-writer --display-name "Prompt Writer Pro"
```

### 5.5 组合更新

```bash
node dist/index.js update prompt-writer \
  --category ai-tools \
  --tags prompt,ai,template \
  --description "Advanced prompt engineering skill"
```

---

## 6. 版本管理 (versions)

### 6.1 查看版本历史

```bash
node dist/index.js versions prompt-writer
```

输出示例：
```
  ── prompt-writer versions (3) ────────────────────────────────────────────────────────────────

    VERSION         HASH        FILES   CREATED
    → 1.2.0         a1b2c3d4    5       2026-06-25 14:20
      1.1.0         b2c3d4e5    4       2026-06-22 09:15
      1.0.0         c3d4e5f6    3       2026-06-20 10:30
```

> `→` 标记表示当前版本

```bash
node dist/index.js versions prompt-writer --show v1.1.0
```

输出示例：
```
  ── prompt-writer v1.1.0 ───────────────────────

      hash          b2c3d4e5f6a7…
      files         4
      storage       skills/prompt-writer/v1.1.0/
      created       2026-06-22 09:15:00
      summary       Updated prompt structure
```

### 6.3 版本对比 (diff)

```bash
# 对比两个版本
node dist/index.js versions prompt-writer --diff v1.0.0..v1.2.0
```

输出示例：
```
  ── prompt-writer  v1.0.0 → v1.2.0  2 ────────────────────────────────────────────────────────────────

  +  templates/advanced.md
  +  examples/code-review.md
  ~  SKILL.md
    --- v1.0.0/SKILL.md
    +++ v1.2.0/SKILL.md
    @@ -1,2 +1,2 @@
     name: prompt-writer
    -version: 1.0.0
    +version: 1.2.0
```

---

## 7. 版本回滚 (rollback)

```bash
# 回滚到指定版本
node dist/index.js rollback prompt-writer --to v1.0.0

# 回滚并指定版本号递增类型
node dist/index.js rollback prompt-writer --to v1.0.0 --bump minor
```

输出示例：
```
  ── Rolling back ────────────────────────────────

  Rolling back  prompt-writer  v1.2.0 → v1.0.0

  ── rollback complete ───────────────────────────

      new version   v1.3.0  (patch bump)
      files restored  3
```

---

## 8. 技能删除 (remove)

```bash
# 删除技能（会提示确认）
node dist/index.js remove prompt-writer

# 强制删除（跳过确认）
node dist/index.js remove prompt-writer --force
```

输出示例：
```
  Remove prompt-writer (v1.2.0)? [y/N] y

  ── removed ─────────────────────────────────────

      slug          prompt-writer
      version       v1.2.0
      storage       skills/prompt-writer/
```

---

## 10. 技能同步 (sync)

### 10.1 检查单个技能是否有更新

```bash
node dist/index.js sync check prompt-writer
```

输出示例（有更新）：
```
  ── sync check ────────────────────────────────────────────────────────────────

    slug          prompt-writer
    version       v1.2.0
    source        https://github.com/user/repo
    branch        main
    sub-dir       skills/prompt-writer
    imported      2026-06-25 14:20:00

  ✓  Update available

    local hash    a1b2c3d4e5f67890…
    remote hash   b2c3d4e5f6a78901…

  Run skill-mcp sync pull prompt-writer to update
```

输出示例（无更新）：
```
  ── sync check ────────────────────────────────────────────────────────────────

    slug          prompt-writer
    version       v1.2.0
    source        https://github.com/user/repo
    branch        main

  ✓  Already up to date
```

### 10.2 检查所有远程技能

```bash
node dist/index.js sync check --all
```

输出示例：
```
  ── sync results (3) ────────────────────────────────────────────────────────────────

  ✓ 2 update(s) available:

    prompt-writer  v1.2.0 → update available
    code-reviewer  v0.3.1 → update available

  Run skill-mcp sync pull <slug> to update each skill

  ✓ 1 skill(s) already up to date
```

### 10.3 拉取更新

```bash
node dist/index.js sync pull prompt-writer
```

输出示例：
```
  ✓  Updated prompt-writer to v1.3.0
    source        https://github.com/user/repo
    branch        main
```

## 9. 技能质量检查 (lint)

```bash
# 检查技能目录
node dist/index.js lint ./my-skill
```

输出示例：
```
  ── Lint Results ────────────────────────────────

  CHECKS:
    ✓ SKILL.md  2.3 KB
    ✓ name  "my-skill"
    ✓ manifest_schema  "v1"
    ✓ retrieval signals present (triggers + whenToUse)
    ✓ eval_cases  3 case(s)
    ✓ version  "1.0.0" (valid semver)
    ✓ No suspicious patterns
    ✓ All referenced files exist
    ✓ No path traversal patterns
    ✓ All files are text

  RESULT: 0 errors, 0 warnings
```

---

## 10. 完整工作流示例

### 10.1 创建并导入新技能

```bash
# 1. 创建技能目录
mkdir -p my-new-skill/templates

# 2. 创建 SKILL.md
cat > my-new-skill/SKILL.md << 'EOF'
---
name: my-new-skill
version: 1.0.0
description: A new skill for testing
category: testing
tags: test, demo
triggers:
  - test skill
  - demo skill
whenToUse: When user wants to test the skill system
evalCases:
  - input: "test the skill"
    expected: "Skill executed successfully"
---

# My New Skill

This is a test skill for demonstration.
EOF

# 3. 创建其他文件
echo "# Template" > my-new-skill/templates/basic.md

# 4. 检查技能质量
node dist/index.js lint ./my-new-skill

# 5. 导入技能
node dist/index.js import ./my-new-skill

# 6. 验证导入
node dist/index.js list
node dist/index.js info my-new-skill
```

### 10.2 更新技能并创建新版本

```bash
# 1. 修改技能文件
echo "## Updated Content" >> my-new-skill/SKILL.md

# 2. 更新版本号
sed -i 's/version: 1.0.0/version: 1.1.0/' my-new-skill/SKILL.md

# 3. 重新导入（自动创建新版本）
node dist/index.js import ./my-new-skill --overwrite

# 4. 查看版本历史
node dist/index.js versions my-new-skill

# 5. 对比版本差异
node dist/index.js versions my-new-skill --diff v1.0.0..v1.1.0
```

### 10.3 回滚到旧版本

```bash
# 1. 查看当前版本
node dist/index.js info my-new-skill

# 2. 查看版本历史
node dist/index.js versions my-new-skill

# 3. 回滚到 v1.0.0
node dist/index.js rollback my-new-skill --to v1.0.0

# 4. 验证回滚
node dist/index.js info my-new-skill
```

---

## 11. 远程模式操作

### 11.1 配置远程服务器

```bash
# 设置环境变量
export SKILL_MCP_SERVER_URL=http://localhost:3000

# 或使用 --server-url 参数
node dist/index.js list --server-url http://localhost:3000
```

### 11.2 远程导入

```bash
# 登录远程服务器
node dist/index.js auth login --server-url http://localhost:3000

# 导入到远程服务器
node dist/index.js import ./my-skill --server-url http://localhost:3000

# 查看远程技能列表
node dist/index.js list --server-url http://localhost:3000
```

---

## 12. 环境变量参考

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DATABASE_PATH` | 数据库文件路径 | `~/.skill-mcp/skill-mcp.db` |
| `STORAGE_BASE_PATH` | 技能存储路径 | `~/.skill-mcp/data/skills` |
| `AUTH_TOKEN` | 认证令牌 | - |
| `SKILL_MCP_SERVER_URL` | 远程服务器 URL | - |
| `DEPLOYMENT_MODE` | 部署模式 | `standalone` |
| `TRANSPORT_TYPE` | 传输类型 | `stdio` |
| `LOG_LEVEL` | 日志级别 | `info` |

---

## 13. 故障排查

### 13.1 数据库未初始化

```
Error: no such table: skills
```

解决方案：
```bash
node dist/index.js init --username admin --password admin888
```

### 13.2 未登录

```
Error: Not logged in. Run `skill-mcp auth login` first.
```

解决方案：
```bash
node dist/index.js auth login
```

### 13.3 技能已存在

```
Error: Skill "my-skill" already exists
```

解决方案：
```bash
# 使用 --overwrite 覆盖
node dist/index.js import ./my-skill --overwrite

# 或使用 --allow-duplicate 允许重复
node dist/index.js import ./my-skill --allow-duplicate
```

### 13.4 版本不存在

```
Error: Version v2.0.0 not found
```

解决方案：
```bash
# 先查看可用版本
node dist/index.js versions my-skill

# 使用正确的版本号
node dist/index.js rollback my-skill --to v1.0.0
```
