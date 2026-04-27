# 发布指南

本文档说明如何将 `skill-mcp` 发布到 npm registry。

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
创建 GitHub Release
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
3. GitHub Actions 自动触发发布

#### 方式三：使用 npm scripts

```bash
# 补丁版本 (1.0.0 → 1.0.1)
npm run release:patch

# 次版本 (1.0.0 → 1.1.0)
npm run release:minor

# 主版本 (1.0.0 → 2.0.0)
npm run release:major
```

### 版本号规则

项目遵循 [Semantic Versioning](https://semver.org/) 规范：

- **主版本号 (MAJOR)**：不兼容的 API 变更
- **次版本号 (MINOR)**：向下兼容的功能新增
- **修订号 (PATCH)**：向下兼容的问题修正

### 发布前检查

在发布前，请确保：

- [ ] 所有测试通过
- [ ] 代码已通过 ESLint 检查
- [ ] TypeScript 编译无错误
- [ ] 文档已更新（README.md、README.zh.md）
- [ ] CHANGELOG.md 已更新
- [ ] 没有破坏性变更或已文档化

## GitHub Actions Workflows

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
   - 访问 https://www.npmjs.com/package/skill-mcp
   - 确认版本号和发布时间正确

2. **GitHub Release**
   - 访问 repository 的 Releases 页面
   - 确认 Release 说明正确

3. **安装测试**
   ```bash
   npm install -g skill-mcp@<version>
   skill-mcp --help
   ```

## 回滚

如果发现问题需要回滚：

```bash
# 撤销 npm 发布（72 小时内）
npm unpublish skill-mcp@<version> --force

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
Git tag version: 1.1.0
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