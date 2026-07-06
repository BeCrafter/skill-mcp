# Scripts

本目录包含项目工具脚本。

## 可用脚本

### sync-docs.js

文档同步检查工具，用于验证 README.md 与代码库的一致性。

**用途**:
- 检查 CLI 命令是否在 README 中有文档
- 检查 MCP 工具是否在 README 中有说明
- 检查环境变量是否在 README 中有记录
- 验证中文 README 是否存在

**使用方法**:
```bash
# 完整检查
npm run docs:sync

# 仅检查新增文件影响
npm run docs:sync -- --check-new-only

# 静默模式（仅输出错误）
npm run docs:sync -- --quiet
```

**检查项**:
- CLI 命令同步（`src/cli/commands/`）
- MCP 工具同步（`src/mcp/tools/`）
- 环境变量同步（`src/config/schema.ts`）

## 添加新脚本

添加新脚本时：

1. 在此目录创建脚本文件
2. 添加 shebang 和错误处理
3. 设置可执行权限：`chmod +x script-name.sh`
4. 在此 README 中添加说明
5. 测试脚本：`node scripts/script-name.js` 或 `bash scripts/script-name.sh`

## 相关文档

- [部署场景](../docs/SCENARIOS/) - 详细的部署场景说明
- [Docker 部署](../docker/README.md) - Docker 部署配置
- [生产部署](../docs/PRODUCTION_DEPLOYMENT.md) - 生产环境部署指南
