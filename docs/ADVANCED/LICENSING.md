# Licensing Policy


## 当前状态（2026-05-28）

- 仓库 `LICENSE` 文件：**MIT**（自 2026-04-27 commit `aee10c8` 之前确立，覆盖 v0.1.x beta 阶段）
- `package.json` 字段：未显式声明，默认随仓库 LICENSE
- 文件头版权声明：未批量加（首个企业客户签约前补）

## 目标 License 模型

参考 §18.4 OSS / Commercial 边界表，本项目计划采用**双 license 分层**：

| 模块 | License | 备注 |
|---|---|---|
| **Core 服务**（`src/`：MCP server / SkillService / provider / cache / storage / pipeline / RBAC） | **BUSL-1.1 with 4-year change date → Apache 2.0**（v0.2.x 起切换） | 商用 SaaS 友好，4 年后自动转 OSS — 兼顾企业付费意愿与社区信任 |
| **SDK**（TS / Python，未来 `packages/sdk-*/`） | **Apache 2.0** | 行业事实标准（HashiCorp / Datadog / Stripe SDK 全 OSS）；闭源 SDK 在 2026 开发者生态等于 DOA |
| **CLI / 部署模板**（`docker-compose.*.yml`） | **Apache 2.0** | 客户运维场景必须 OSS 才能改 |
| **Pipeline YAML editor + 只读运行视图 UI**（未来 `admin-ui/`） | **Apache 2.0** | 开发者实操区是 OSS 体验底线 |
| **Pipeline 写权限 UI / Audit Export / 商业 Connector** | **Commercial Only**（闭源） | 企业付费意愿点 |
| **示例 skills**（`skills/` / `docs/examples/`） | **CC0 / Public Domain** | 鼓励复用 |

## 切换路线图

### Phase 1（当前 → v0.1.x beta）：保持 MIT

- 继续 MIT，便于早期 contributor 试用与 fork
- 不在文件头加版权声明（避免 churn）
- 任何 OSS contribution 隐含 MIT 授权

### Phase 2（v0.2.0 起 → 第一个企业客户签约前）：切换到 BUSL-1.1

**触发条件**：销售确认有 ≥1 个企业 PoC / 付费 LOI（letter of intent），或团队决定开始商业化运营。

**切换动作**（约 4 人日，对应 §11 P0-11）：

1. **License 选型确认**（0.5d）
   - 法务 review BUSL-1.1 条款，确认 "Use Limitation" 范围（"production use" 排除竞品 SaaS）
   - 确认 Change Date（推荐 4 年）+ Change License（Apache 2.0）
   - 在 `LICENSE` 文件头部保留 MIT 历史声明（"Versions ≤ 0.1.x are licensed under MIT"），从 v0.2.0 起新代码 BUSL-1.1
2. **替换 LICENSE 文件**（0.5d）
   - 使用 [BUSL-1.1 模板](https://mariadb.com/bsl11/)
   - 头部添加 Licensor / Licensed Work / Additional Use Grant / Change Date / Change License 字段
3. **添加 NOTICE 文件**（0.5d）
   - 列出第三方依赖 license（用 `license-checker` 自动生成 + 手工 review）
   - 列出本项目 BUSL-1.1 的 "Additional Use Grant"（允许内部使用，禁止做竞品 SaaS）
4. **CONTRIBUTING.md 加 DCO sign-off**（0.5d，见下文）
5. **CLA 模板（备选）**（0.5d）
   - 选 DCO（轻量，Linux kernel / docker / GitLab 模式） vs CLA（需要 contributor 单独签约，Apache foundation / Google 模式）
   - **推荐 DCO**：早期 contributor 数量少，CLA 提高门槛；DCO 法律效力对内部企业客户合同足够
6. **`MAINTAINERS.md`**（0.5d）—— 列出 maintainer + 决策机制（lazy consensus / RFC）
7. **`SECURITY.md`**（0.5d）—— 漏洞报送渠道 + 90 天 disclosure 政策
8. **`CODE_OF_CONDUCT.md`**（0.5d）—— Contributor Covenant 2.1 模板
9. **批量加文件头**（0.5d）—— `src/*.ts` 头部加 `// Copyright (c) 2026 Smartisan, BUSL-1.1 from v0.2.0` 脚本

### Phase 3（v1.0 GA）：稳态

- BUSL-1.1 + Apache 2.0 双 license 已落地
- 4 年滚动 Change Date：每个 commit 都有自己的 4 年期
- 商业版 EULA 单独维护（不属本仓库）

## OSS / Commercial 边界（再次确认）

**OSS（开放源代码 + 允许 fork）**：

- ✅ 全部 SDK（TS / Python / 未来 Go）
- ✅ Core 服务（BUSL 限制后 4 年内不可做竞品 SaaS，但可自部署 / 内部使用 / 学术 / fork）
- ✅ Pipeline YAML 引擎 + 只读运行视图 UI
- ✅ CLI / Docker Compose / 部署模板
- ✅ 文档 + 示例 skills

**Commercial Only（闭源 + 仅付费版可用）**：

- 🔒 Pipeline 写权限 UI（创建 / 编辑 pipeline）
- 🔒 Workspace / 组织隔离
- 🔒 高级 RBAC（attribute-based / row-level）
- 🔒 Audit Export（合规客户必备）
- 🔒 商业 Connector（Salesforce / Slack / Jira / SSO Enterprise）
- 🔒 Embedding 检索 + Skill eval 框架（差异化能力）

## 反模式（必须避免）

1. **License 钓鱼切换**（GitLab / Elastic / Sentry 历史教训）：从 MIT/Apache 直接切到非 OSS license 不预告，社区信任崩塌。**对策**：本仓库公开承诺 "Phase 1 → 2 切换需提前 30 天发 Issue + 邮件 mailing list"。
2. **CLA 阻塞 PR**：CLA 签约流程长，吓走 contributor。**对策**：用 DCO（git commit 加 `Signed-off-by:`）。
3. **文件头版权声明遗漏**：BUSL-1.1 切换时如果 src/ 文件头没声明，license 状态歧义。**对策**：Phase 2 切换时一次性脚本批量加 + pre-commit hook 强制。
4. **NOTICE 第三方依赖漏列**：被法务发现后必须紧急补，影响合同签约。**对策**：CI 加 `license-checker --production --json` 检查，输出 diff 必须 review。

## 参考资料

- [BUSL-1.1 官方页面（MariaDB）](https://mariadb.com/bsl11/)
- [SPDX License List](https://spdx.org/licenses/)
- [DCO 流程（Docker / Linux Foundation）](https://developercertificate.org/)
- [Choose A License](https://choosealicense.com/)
- §18.4 OSS / Commercial 边界表（本项目专用）
