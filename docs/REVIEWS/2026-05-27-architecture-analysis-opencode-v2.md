# Skill-MCP 架构分析报告（v2）

> **来源**：opencode CLI 架构分析（v1）+ Claude Sonnet 4.6 交叉审阅修正
> **状态**：✅ 第二版 — 已吸收 v1 §7 交叉审阅的全部修正
> **生成上下文**：AI AGENT 架构工程师视角，从架构到实现细节逐层分析，评估商用就绪度
> **版本关系**：本版取代 [v1](./2026-05-27-architecture-analysis-opencode.md)；v1 作为历史档案保留，可对比修订内容

---

## 〇、评审范围（v2 新增）

| 项 | 说明 |
|---|---|
| 评审 commit | `b4c7093`（pipeline run repo 测试）+ `b4bd183`（MCP server 测试）之前的 dev 分支 |
| 已计入 | `src/`（含 handlers、services、provider、cache、pipeline）、`docs/REFACTORING_BACKLOG.md` 全部 39 项 T-### 任务、`docs/ARCHITECTURE.md` 第 9 节已知问题清单 |
| 跳过 | `tests/`（仅看测试统计）、`scripts/`、构建工具链 |
| 验证手段 | `npx vitest run --reporter=basic` → 743 用例；`grep -oE "T-[0-9]+" docs/REFACTORING_BACKLOG.md \| sort -u` → T-701~T-739 |
| 与 Claude 评审关系 | 见 §5。两份评审互补：opencode 偏代码债，Claude 偏商业化空白 |

---

## 一、架构现状：优秀但未完成的中后期项目

### 核心评估（⭐️⭐️⭐️⭐️）

代码库质量**远高于平均水平**。经历了 **19+ 轮安全加固审计 / 共 39 项任务**（T-701 ~ T-739），构建了扎实的基础：

| 维度 | 评级 | 说明 |
|---|---|---|
| **分层架构** | ⭐️⭐️⭐️⭐️⭐️ | clean layered 架构，依赖方向严格，ISkillProvider/Cache/Storage 抽象完善 |
| **安全纵深** | ⭐️⭐️⭐️⭐️⭐️ | 4 层鉴权（stdio/gateway/admin/metrics）+ staging-commit + 路径校验 |
| **测试覆盖** | ⭐️⭐️⭐️⭐️ | **743 单测 / 93 文件**通过，含回滚/幂等/并发等困难场景 |
| **文档质量** | ⭐️⭐️⭐️⭐️⭐️ | ARCHITECTURE.md 作为 SSOT，BACKLOG 追踪数十项已知问题 |
| **可观测性** | ⭐️⭐️⭐️ | Prometheus 指标较全（10+）但缺乏结构化日志/OpenTelemetry |
| **可扩展性** | ⭐️⭐️⭐️ | 扩展点清晰（provider/storage/transport）但缺乏插件机制 |
| **商用就绪度** | ⭐️⭐️⭐️ | 单机可用，分布式待完善，多租户已有 RBAC 但缺配额 |

---

## 二、分层架构评估

### 2.1 核心层（Strategy 层）✅ 强

```
Client → Transport → MCP Tools / HTTP Handlers → SkillService → Provider → Storage/DB
                                                      ↕
                                              Cache ←→ EventBus
```

**优点**：
- 依赖方向明确，无循环引用
- ISkillProvider 接口支持 Local/Remote 两种实现，`instrument.ts` Proxy 透明埋指标
- CompositeCacheProvider（L1 LRU + L2 File）设计精良，per-user epoch 失效是亮点

**问题**：
- **`src/http/handlers/admin/skills.handler.ts` 跳过 Service 层直接操作 Repo/Storage**（ARCHITECTURE.md §9 已知问题）——这是一个核心分层的系统性违反，不是"偶尔绕过"。195 行中有大量直读 `skillRepo.findAll()` / `storage.deleteDir()`，只有少数走 `skillService.*`。应统一入口。

### 2.2 数据层 ✅ 强但有单体瓶颈

- **better-sqlite3 binding 同步阻塞 event loop + SQLite 单写者锁**：单进程内性能极佳（~50k qps），但**横向扩展为零**（多 cloud-service 副本场景下出现单写者瓶颈）
- Drizzle ORM + 迁移机制完整，有 `pipeline_runs` JSON 落库，有 `ON DELETE CASCADE` + UNIQUE 约束
- **已知问题**：`access_logs` 无 CASCADE（9.4 已修复，0001 迁移重建表）；`user_roles` 缺 UNIQUE (user_id, role_id)（9.30 已修复，0005 迁移）

### 2.3 Pipeline 子系统 ⚠️ 实验性

YAML-based DAG pipeline（plan→exec 两阶段执行器）——功能上可行，但：
- **无监控**：长时间运行的 pipeline 无法取消、无法暂停
- **无超时强制终止**：仅有 TTL 30min（staleness check），无 absolute deadline
- **resume 并发 lock** 已实现（T-709）但该功能整体缺乏生产验证
- **无运行历史审计**：通过 `pipeline_runs` 表落库但无法展示进度 UI

### 2.4 缓存层 ✅ 优秀，但 epoch 跨进程缺陷需注意

`CacheEpochManager` (T-102) 用 O(1) epoch bump 替代 O(n) prefix scan 是教科书级设计。FileCache 周期性 GC (T-403) 已落地。

**跨进程缺陷**：epoch 是**纯内存**的。任何**多进程 / 多副本场景**（无论 standalone HA、gateway 模式多 cloud-service 副本）下都会出现各副本 epoch 计数器不一致 → cache 副本间分歧。需要外部化 epoch 存储（Redis）才能彻底解决。当前 gateway 模式之所以不出问题，是因为缓存主要在 cloud-service 侧的 `LocalProvider` 里 — 这是隐式假设，应在 ARCHITECTURE.md 中显式记录。

---

## 三、商用就绪：统一优先级清单（v2 合并原 §3 + §5）

> **变更说明**：v1 中 §3 的分级清单（11 项）与 §5 的 ROI 表（10 项）重叠且优先级排序不一致。v2 合并为一份按 ROI 排序的统一清单，每条带工作量、影响范围、改动落点、关键依赖。

### 🔴 P0：必须解决后方可商用

| # | 项目 | 工作量 | 改动落点 | 主要收益 | 备注 |
|---|---|---|---|---|---|
| P0-1 | **admin handler 统一走 SkillService** | 3-5 天 | `admin/skills.handler.ts` + `skill.service.ts` 加 `admin*` 方法组 | 修复分层违反，缓存失效 / 权限校验 / 访问日志不再遗漏 | 与 §4.1 深层问题对应 |
| P0-2 | **PG 兼容 + 分布式 DB 选型** | **1-2 月 dialect 切换 + 1-2 月生产观察** | drizzle schema (pg dialect) + connection pool + migrator | 水平扩展能力，消除单写者瓶颈 | 保持 dev/CI 走 SQLite，prod 切 PG |
| P0-3 | **速率限制 + 资源配额** | 3-5 天 | `compose.ts` token bucket 中间件 + skillRepo quota columns + import semaphore | 防滥用，避免认证用户打满 SQLite | 当前 T-702/T-705/T-717/T-725/T-726 是零散防护 |
| P0-4 | **OpenAPI 规格 + 契约固化** | 5-7 天 | `zod-to-openapi` + `src/http/openapi.ts` + `docs/openapi.json` | 可生成 SDK，gateway 消费方对接成本骤降 | 比换 Fastify/NestJS 侵入性小 |

### 🟠 P1：影响 SLA 的缺口

| # | 项目 | 工作量 | 改动落点 | 主要收益 |
|---|---|---|---|---|
| P1-1 | **优雅关闭** | 1-2 天 | `SIGTERM` handler + `Server.close(cb)` + Pipeline `beforeExit` flush | 生产可靠性，避免 in-flight 请求被切断 |
| P1-2 | **事件总线异步化 + 跨进程广播** | 2-3 天 | `EventBus` → `p-queue` + 可切换 Redis Pub/Sub adapter | 性能 + 多副本一致性（同时解决 §2.4 epoch 跨进程） |
| P1-3 | **OpenTelemetry 集成** | 3-5 天 | `@opentelemetry/api` + `compose.ts` 中间件链 + `SkillService`/`Provider` 出口 span | 分布式追踪，单次请求延迟可拆分 |
| P1-4 | **Admin GUI** | 2-4 周 | `admin-ui/` React + Vite，复用 `/api/admin/*` | 推广给非技术用户，降低 curl/CLI 门槛 |

### 🟡 P2：体验和质量改进

| # | 项目 | 工作量 | 改动落点 | 主要收益 |
|---|---|---|---|---|
| P2-1 | **Helm Chart / K8s 规范** | 5-7 天 | `deploy/charts/skill-mcp/`，4 种 mode values 模板 | K8s 原生部署，readinessProbe / HPA / ConfigMap |
| P2-2 | **E2E 测试补充** | 1-2 周 | Playwright + Docker Compose C2 拓扑 | 发布信心：import → gateway auth → MCP call → RBAC gate → cache serve 全链路 |
| P2-3 | **手写 Router 维护方案** | 1-2 天 | 路由清单自动测试 `tests/unit/http/routes-coverage.test.ts`，或迁移 `itty-router` | 路径冲突静态可检测 |
| P2-4 | **CLI 交互式体验** | 3-5 天 | import 命令加 spinner/progress，`--interactive` 引导 | 首次安装成功率 |

---

## 四、深层架构问题

### 4.1 `admin/skills.handler.ts` 系统性违反分层原则

当前 admin handler **大部分操作直接调 Repo/Storage**：
- `skillRepo.findAll()` — 跳过 TagPermissionFilter
- `skillRepo.findBySlug()` — 跳过 Service
- `storage.deleteDir()` — 直接操作物理层
- `importer.import()` — 跳过 Service

**根因**：`SkillService` 设计偏 "MCP 工具调用"，REST admin 路径被认为是 "内部管理" 所以绕过了 service。这是错误假设：admin 操作同样需要：
- 缓存失效（当前靠手动 `eventBus.publish` 但容易漏）
- 权限校验（确保操作人有 `admin:write` tag）
- 访问日志

**建议**：在 `SkillService` 上加 `admin*` 方法组（`adminListSkills` / `adminDeleteSkill` / `adminImportSkill`），由它们负责 caching + event publish + logging，admin handler 只做 body 投影（T-728）和路由匹配。

### 4.2 `ICacheProvider` 接口无法跨进程

Cache 键包含 `userId` 和 `CacheEpochManager` 版本号——但 epochs 是**纯内存**的。任何多进程 / 多副本部署（standalone HA / gateway 多 cloud-service 副本）都会出现各副本 epoch 不一致，cache 在副本间分歧。

**当前规避**：gateway 模式走 `RemoteProvider` + `HttpTransport`，缓存主要落在 cloud-service 侧的 `LocalProvider` 里。这是隐式假设，应在 ARCHITECTURE.md §7 显式记录。

**根治路径**：见 P1-2，引入 Redis Pub/Sub 同步 epoch。

### 4.3 `PipelineExecutor` Plan/Exec 分离不彻底

> v1 标题为"伪两阶段"，易与 2PC（two-phase commit）混淆。v2 改为"Plan/Exec 分离不彻底"。此处"两阶段"指 plan→exec，**非 prepare/commit 的 2PC**。

虽然设计文档说 "不直接调 LLM"，但 `start()` 调用 `executeBatch()` → `buildStageRequests()` 已经对 `viewSkillEntry` 做了 IO（读 storage/DB）。当 pipeline 第一次返回 `Awaiting` 状态时，一部分副作用已经发生。架构理想是**纯计算先行（plan 阶段无 IO 副作用）**，现实是边缘模糊。

**建议**：把 `buildStageRequests` 拆为 `planStageRequests`（纯函数）+ `materializeStageInputs`（执行期再读 IO），让 plan 可以在 Awaiting 之前完整 dump 给 LLM 审查。

---

## 五、与 Claude 商用化评审的共识与差异（v2 新增）

参见 [`2026-05-27-commercialization-review-claude.md`](./2026-05-27-commercialization-review-claude.md)。

### 5.1 共识（两份评审都强调）

- **SQLite 单体瓶颈**是商用最大单点
- **admin handler 系统性违反分层**需统一走 SkillService
- **缺速率限制 / 配额**是滥用风险
- **缺 OpenTelemetry**导致故障排查困难
- **缺优雅关闭**影响生产 SLA

### 5.2 opencode 独有的洞察

- **§4.1** admin handler 195 行的具体分层违反代码层面证据
- **§4.2** cache epoch 跨进程缺陷（Claude 评审未深入）
- **§4.3** Pipeline Plan/Exec 分离不彻底
- ROI 表细到天数级别工作量预估

### 5.3 Claude 评审独有的洞察（本评审未覆盖）

- **战略定位**：A/B/C 三方向选择，推荐企业 Skill Registry
- **多租户 / Workspace 模型缺失**：当前只有 user + role + tag 三层，缺租户隔离
- **商业化基础设施**：计量 / 配额 / billing schema 设计
- **`skill_list` 全量返回是反 AI 模式**：缺 embedding 检索 / lifecycle / eval 框架
- **SDK 生态**：npm / Python SDK、CLI 分发、IDE 插件
- **服务层过薄**：建议拆 Catalog / Import / Lifecycle / Identity / Billing 五个子服务

### 5.4 推荐阅读路径

- 看**代码债 + 当前工程现状** → 读本评审 §2~§4
- 看**未来商业化空白 + 战略选择** → 读 Claude 评审 §1、§2、§11
- 看**统一优先级清单** → 读本评审 §3（已合并 v1 §3+§5），并对照 Claude 评审 §11 路线图

---

## 六、总结：从 MCP 工具到商用平台的跨越路线

当前代码处于**"功能完整、安全经过 19+ 轮审计、但尚未达到商用 SLA"**的位置。核心产品价值（MCP Skill 仓库 + RBAC 网关）已充分实现，代码质量在同类项目中属于顶级（743 单测 + 39 项安全任务 + clean layered 架构 + epoch 缓存 + staging-commit）。

### 进化为商用平台需完成（按影响排序）：

1. **DB 层**：SQLite → PG（最大架构变更，P0-2）
2. **服务层补强**：admin handler 统一走 Service + 拆分 Catalog/Import/Lifecycle 等子服务（P0-1，结合 Claude 评审 §4）
3. **API 面**：手写路由 → OpenAPI 文档（最大开发者体验提升，P0-4）
4. **部署面**：Docker Compose → Helm Chart + HPA + graceful shutdown（最大运维提升，P1-1 + P2-1）
5. **观察性**：结构化日志 → OpenTelemetry traces + metrics dashboard（最大故障排查提升，P1-3）
6. **管理面**：REST-only → Admin Web UI + CLI 交互式体验（最大用户推广提升，P1-4 + P2-4）

### 警惕过度工程化

项目当前 "单二进制四模式" 的架构选择是其最大优势。切换到 PG 后**不应丢失本地开发的一条命令启动体验**（当前 `npm start` 即可工作，靠 SQLite 零依赖）。建议保持 **local dev 走 SQLite、CI/test 也走 SQLite、production 切换 PG** 的策略 — 这要求 drizzle 双 dialect 同时维护。

---

## 变更日志

| 日期 | 来源 | 备注 |
|---|---|---|
| 2026-05-27 | opencode CLI | v1 初版生成 |
| 2026-05-27 | Claude Sonnet 4.6 | v1 §7 追加交叉审阅（事实修正 / 结构建议 / 补充维度 / 7.5 分评分） |
| 2026-05-27 | Claude Sonnet 4.6 | **v2 发布**：吸收 v1 §7 全部修正 — 测试数 440→743、审计轮次 11+→19+ 轮 / 39 任务、§3.1/§4.2 矛盾消除（gateway 节点无状态）、PG 工时统一 1-2 月 + 1-2 月、§3.2 better-sqlite3 措辞校准、§4.3 改为 "Plan/Exec 分离不彻底"、§3 与原 §5 合并为统一 ROI 清单、新增 §0 评审范围与 §5 与 Claude 评审差异。v1 作为历史档案保留 |
