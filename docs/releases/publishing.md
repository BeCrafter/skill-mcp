# 发布指南

将 `skill-mcp` 发布到 npm registry 的流程。

## 发布流程

### 流程概览

```
npm run release:<type>   # bump 版本、提交、打 tag、推送
        ↓
Git tag (v*.*.*) 触发 publish.yml
        ↓
build + lint + test → 同步版本号 → 发布到 npm → GitHub Release（仅 latest/rc）
```

### 触发方式

#### 方式一：npm scripts（推荐）

```bash
# 修订号 (0.1.0 → 0.1.1)
npm run release:patch

# 次版本 (0.1.0 → 0.2.0)
npm run release:minor

# 主版本 (0.1.0 → 1.0.0)
npm run release:major

# 预发布
npm run release:beta   # 也支持 alpha / rc / dev
```

`release:*` 脚本执行 `npm version <type>` 并 `git push --follow-tags`，推送的 tag 触发 `publish.yml`。

#### 方式二：手动 tag

```bash
# 更新 package.json 版本号后
git tag v0.1.1
git push origin v0.1.1
```

或通过 GitHub Actions `workflow_dispatch` 手动触发 `publish.yml`。

### 版本号规则

遵循 [Semantic Versioning](https://semver.org/)。当前发布线为 `0.1.x`（`package.json` 为 `0.1.1-beta.0`）。

### 发布前检查

- [ ] 所有测试通过（`npm test`）
- [ ] ESLint 无错（`npm run lint`）
- [ ] TypeScript 编译无错（`npm run build`）
- [ ] 文档已更新（README.md、README.zh.md）
- [ ] 没有破坏性变更或已文档化

> `prepublishOnly` 钩子会自动执行 `build && lint && test`，任一失败则中止发布。

## GitHub Actions Workflows

### CI Workflow (`.github/workflows/ci.yml`)

在每个 PR 和 push 时运行：ESLint、TypeScript 编译、测试、覆盖率报告。

### Publish Workflow (`.github/workflows/publish.yml`)

在推送 `v*.*.*` tag（或 `workflow_dispatch`）时触发：

1. 运行完整 CI 检查（build + lint + test）
2. **同步版本号**：检测 `package.json` 与 tag 不一致时，自动提交同步后的 `package.json`/`package-lock.json` 并 force-push 到 `main`（不会因版本不匹配而失败）
3. 发布到 npm（`latest` tag；预发布如 `beta` 带 `beta` dist-tag）
4. 创建 GitHub Release **仅当** npm tag 为 `latest` 或 `rc`（`alpha`/`beta`/`dev`/`next` 跳过 Release）

> `.github/workflows/` 中的 `release-pr.yml.bak` 与 `create-tag.yml.bak` 是已废弃的自动 Release-PR / 自动 tag 流水线（GitHub Actions 不识别 `.bak`），不再生效。发布统一经 `release:*` 脚本 + `publish.yml`。

## 配置

### npm Token

GitHub repository Settings → Secrets and variables → Actions → 新增 `NPM_TOKEN`（npm automation token，见 https://www.npmjs.com/settings/tokens ）。

## 发布后验证

1. **npm registry**：https://www.npmjs.com/package/skill-mcp 确认版本与发布时间
2. **GitHub Release**（仅 `latest`/`rc`）：仓库 Releases 页确认说明
3. **安装测试**：
   ```bash
   npm install -g skill-mcp@<version>
   skill-mcp --help
   ```

## 回滚

```bash
# 撤销 npm 发布（72 小时内）
npm unpublish skill-mcp@<version> --force

# 或发布新版本修复
npm run release:patch
```

npm 仅允许发布后 72 小时内撤销；超时需发布新版本。

## 故障排除

### 发布失败
检查：npm token 配置、CI 是否全过、文件冲突/权限。查看 GitHub Actions 日志。

### npm 认证失败
确保 token 为 "Automation" 类型、已加到 Secrets、未过期。

## 相关文档

- [Semantic Versioning](https://semver.org/)
- [npm publish](https://docs.npmjs.com/cli/v9/commands/npm-publish)
- [GitHub Actions](https://docs.github.com/en/actions)
