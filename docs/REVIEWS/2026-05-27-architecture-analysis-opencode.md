# Skill-MCP 架构分析报告（v1 — 历史档案）

> ⚠️ **本版已归档**：v2 已发布 — 见 [`2026-05-27-architecture-analysis-opencode-v2.md`](./2026-05-27-architecture-analysis-opencode-v2.md)
> v2 已吸收本版 §7 交叉审阅的全部修正。本版仅作历史对比保留。
>
> **来源**：opencode CLI 架构分析工具，基于全代码库扫描生成
> **状态**：📦 历史档案（被 v2 取代）
> **生成上下文**：AI AGENT 架构工程师视角，从架构到实现细节逐层分析，评估商用就绪度

---

## 一、架构现状：优秀但未完成的中后期项目

### 核心评估（⭐️⭐️⭐️⭐️）

代码库质量**远高于平均水平**。经历了 11+ 轮安全加固审计（T-701 ~ T-739），构建了扎实的基础：

| 维度 | 评级 | 说明 |
|---|---|---|
| **分层架构** | ⭐️⭐️⭐️⭐️⭐️ | clean layered 架构，依赖方向严格，ISkillProvider/Cache/Storage 抽象完善 |
| **安全纵深** | ⭐️⭐️⭐️⭐️⭐️ | 4 层鉴权（stdio/gateway/admin/metrics）+ staging-commit + 路径校验 |
| **测试覆盖** | ⭐️⭐️⭐️⭐️ | 440+ 单测通过，含回滚/幂等/并发等困难场景 |
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

- **SQLite + better-sqlite3 同步 API**：单进程内性能极佳（~50k qps），但**横向扩展为零**
- Drizzle ORM + 迁移机制完整，有 `pipeline_runs` JSON 落库，有 `ON DELETE CASCADE` + UNIQUE 约束
- **已知问题**：`access_logs` 无 CASCADE（9.4 已修复，0001 迁移重建表）；`user_roles` 缺 UNIQUE (user_id, role_id)（9.30 已修复，0005 迁移）

### 2.3 Pipeline 子系统 ⚠️ 实验性

YAML-based DAG pipeline（两阶段执行器）——功能上可行，但：
- **无监控**：长时间运行的 pipeline 无法取消、无法暂停
- **无超时强制终止**：仅有 TTL 30min，无 absolute deadline
- **resume 并发 lock** 已实现（T-709）但该功能整体缺乏生产验证
- **无运行历史审计**：通过 `pipeline_runs` 表落库但无法展示进度 UI

### 2.4 缓存层 ✅ 优秀

`CacheEpochManager` (T-102) 用 O(1) epoch bump 替代 O(n) prefix scan 是教科书级设计。FileCache 周期性 GC (T-403) 已落地。

---

## 三、商用就绪：关键缺口

### 🔴 P0：必须解决后方可商用

#### 1. SQLite 单体瓶颈——最大风险

**现状**：better-sqlite3 是同步单线程，`DEPLOYMENT_MODE=gateway` 中 MCP-1 和 MCP-2 各自挂载独立的 `DATABASE_PATH`，互不共享数据。

**建议**：
- **短期**：在 gateway 模式下用同一个 storage service 的 HTTP API（已实现 `RemoteProvider`），MCP 节点自身不带 DB
- **中期**（3-6 月）：把 SQLite 替换为 PostgreSQL（Drizzle ORM 支持 PG），`better-sqlite3` → `pg` pool
- **架构影响**：pg 引入连接池、事务隔离级别差异、`INSERT ... ON CONFLICT` 语义微调

#### 2. 无速率限制 + 无资源配额

**现状**：T-702 (body 10MB) + T-705 (字段上限) + T-717 (sessionId cap) + T-725/T-726 (并发/路径数) 做了零散防护，但：
- **无 per-user rate limiter**：认证用户可 1000 req/s 打满 SQLite
- **无 storage Quota**：无用户/团队的存储量限制
- **无 concurrent import 限制**：pMap(8) 是单次并行数，无全局限流

**建议**：
- 引入 token bucket rate limiter（可复用 `prom-client` 的 counter 做统计）
- 在 `SkillService` 层加 storage quota check
- 加全局 import concurrency semaphore

#### 3. 事件总线是同步单线程

**现状**：`EventBus` 基于 `EventEmitter`，**同步派发**（ARCHITECTURE.md §7.4）。意味着：
- 缓存失效慢时阻塞主请求
- listener 异常已通过 T-401 try/catch 隔离，但仍同步阻塞

**建议**：
- 改用异步消息队列（Redis Pub/Sub 或更轻量的 `p-queue`）
- 多进程部署时事件需跨进程广播（目前 cache epoch 仅在单进程内生效）

#### 4. API 契约脆弱——无 OpenAPI 规范

**现状**：手写 regex Router + `mapErrorToResponse`（T-201）；
- 所有 API 响应结构仅靠 TS 类型保障
- HTTP 状态码映射靠 `instanceof` 不一定完全
- 无法为 gateway 消费者生成 SDK

**建议**：引入 `zod-to-openapi` 从现有 zod schema 生成 OpenAPI 3.1 spec，在 `src/http/` 增加 `openapi.ts` 聚合端点。这比换 Fastify/NestJS 侵入性小。

### 🟠 P1：影响 SLA 的缺口

#### 5. 缺少优雅关闭

**现状**：`process.exit(1)` on error（`src/index.ts:18`），HTTP server 无 `close` 回调等待 in-flight 请求。
- Pipeline 运行中进程被杀 = 进度丢失（虽已落库但正在执行的 batch 丢失）
- SSE 连接突然断开 = 用户侧无重试提示

**建议**：
- `Server.close(cb)` 包裹，`process.on('SIGTERM', ...)` 等待 30s 完成 + 502 告知上游
- Pipeline executor 注册 `beforeExit` 时 flush `completedStages`

#### 6. 无分布式追踪

**现状**：pino 结构化日志但无 traceId 跨异步边界传播，MCP 调用 → HTTP → Provider 链路的延迟拆分靠 Prometheus histogram 但无法关联单次请求。

**建议**：引入 `@opentelemetry/api`，在 `compose.ts` 中间件链起点注入 `traceId`，`SkillService` 和 `Provider` 出口挂 span。

#### 7. 缺少 Admin GUI

**现状**：全部通过 REST API + CLI 操作，无 Web UI。
- skill 列表、导入、权限配置全要 curl / 手打 CLI
- 难以推广给非技术用户

**建议**：用 `src/http/server.ts` 的同一端口 serve 一个极简 SPA（React + Vite，独立目录 `admin-ui/`），参考 tRPC 模式通过已有的 `/api/admin/*` 工作。

### 🟡 P2：体验和质量改进

#### 8. 手写 Router 维护成本

**现状**：`src/http/router.ts` 正则匹配 → `HttpContext` → `compose.ts` koa style 中间件链。虽然灵活但：
- `/api/admin` 的路由注册分散在 handler 文件中的 `register*Routes`
- 无 router tree 可视化
- 无静态分析验证路径不冲突

**建议**：考虑迁移到 `itty-router`（极小依赖 + 兼容 Node http）或继续维护但补路由清单自动测试（`tests/unit/http/routes-coverage.test.ts`）。

#### 9. CLI 缺乏交互式体验

**现状**：commander 基础解析，无交互式安装 wizard、无 tab completion、无进度条（pMap 导入时无 `cli-progress`）。

**建议**：import 命令加 CLI spinner/progress，`--interactive` 模式引导首次安装。

#### 10. 测试分层不均衡

**现状**：440 单测中绝大多数是 unit test。集成测试仅 `scenario-b.test.ts`（9 用例）+ `mcp-transport-auth.test.ts`。**E2E 只有 20 skipped+**。

**建议**：补 production 级 E2E（Docker Compose C2 拓扑下全链路用例）；
- import skill → gateway auth → MCP call → RBAC gate → cache serve
- 网络分区后恢复 -> RemoteProvider `fetchWithRetry` 行为验证

#### 11. 缺少 Helm Chart / Terraform

**现状**：只有 `docker-compose.{production,c1,c2}.yml` + `nginx.conf`，无 Kubernetes 部署规范。
- 无 readinessProbe（当前只是 liveness）
- 无 HPA 配置
- 无 ConfigMap / Secret 管理

**建议**：增加 `deploy/charts/skill-mcp/` Helm chart，带 4 种 mode 的 values 模板。

---

## 四、发现的深层架构问题

### 4.1 `admin/skills.handler.ts` 系统性违反分层原则

当前 admin handler **大部分操作直接调 Repo/Storage**（`skipToService` 贯穿全文）：
- `skillRepo.findAll()` — 跳过 TagPermissionFilter
- `skillRepo.findBySlug()` — 跳过 Service
- `storage.deleteDir()` — 直接操作物理层
- `importer.import()` — 跳过 Service

**根因**：`SkillService` 设计偏"MCP 工具调用"，REST admin 路径被认为是"内部管理"所以绕过了 service。这是错误假设：admin 操作同样需要：
- 缓存失效（当前靠手动 `eventBus.publish` 但容易漏）
- 权限校验（确保操作人有 `admin:write` tag）
- 访问日志

**建议**：在 `SkillService` 上加 `admin*` 方法组（`adminListSkills` / `adminDeleteSkill` / `adminImportSkill`），由它们负责 caching + event publish + logging，admin handler 只做 body 投影（T-728）和路由匹配。

### 4.2 `ICacheProvider` 接口无法跨进程

Cache 键包含 `userId` 和 `CacheEpochManager` 版本号——但 epochs 是**纯内存**的。gateway 模式有 MCP-1/MCP-2 两个副本，各自维护独立的 epoch 计数器，cache 在副本间不一致。

**现状**实际有效是因为 gateway 模式走 `RemoteProvider` + `HttpTransport` 协议，缓存主要在 cloud service 侧的 `LocalProvider` 里——这是一个隐式假设，没有文档记录。

### 4.3 `PipelineExecutor` 是"伪两阶段"

虽然设计文档说"不直接调 LLM"，但 `start()` 调用 `executeBatch()` → `buildStageRequests()` 已经对 `viewSkillEntry` 做了 IO（读 storage/DB）。当 pipeline 第一次返回 `Awaiting` 状态时，一部分副作用已经发生。架构理想是纯计算先行，现实是边缘模糊。

---

## 五、具体优化行动清单（按 ROI 排序）

| 优先级 | 项目 | 预估工作量 | 关键改动范围 | 预期收益 |
|---|---|---|---|---|
| **P0** | admin handler 统一走 SkillService | 3-5 天 | `admin/skills.handler.ts` + `skill.service.ts` 加 admin 方法组 | 修复分层违反，减少缓存/日志遗漏 |
| **P0** | PG 兼容 + 分布式 DB 选型 | 1-2 月 | drizzle schema (pg dialect) + connection pool + migrator | 水平扩展能力 |
| **P0** | 速率限制 + 配额 | 3-5 天 | `compose.ts` 中间件 + skillRepo quota columns | 防滥用 |
| **P1** | OpenAPI 规格 + 文档 | 5-7 天 | `zod-to-openapi` + `docs/openapi.json` | 可集成性 |
| **P1** | 优雅关闭 | 1-2 天 | `SIGTERM` handler + server.close callback | 生产可靠性 |
| **P1** | OpenTelemetry 集成 | 3-5 天 | `@opentelemetry/auto-instrumentations-node` | 分布式追踪 |
| **P1** | 事件总线异步化 | 2-3 天 | EventBus → `p-queue` + 可切换 Redis adapter | 性能 + 跨进程 |
| **P2** | Admin UI | 2-4 周 | `admin-ui/` React + Vite | 可推广性 |
| **P2** | Helm Chart | 5-7 天 | `deploy/charts/skill-mcp/` | K8s 原生部署 |
| **P2** | E2E 测试补充 | 1-2 周 | Playwright + Docker Compose 拓扑 | 发布信心 |

---

## 六、总结：从 MCP 工具到商用平台的跨越路线

当前代码处于**"功能完整、安全经过多轮审计、但尚未达到商用 SLA"**的位置。核心产品价值（MCP Skill 仓库 + RBAC 网关）已充分实现，11 轮安全审计后的代码质量在同类项目中属于顶级。

### 进化为商用平台需完成：
1. **DB 层**：SQLite → PG（最大架构变更）
2. **API 面**：手写路由 → OpenAPI 文档（最大开发者体验提升）
3. **部署面**：Docker Compose → Helm Chart + HPA + graceful shutdown（最大运维提升）
4. **观察性**：结构化日志 → OpenTelemetry traces + metrics dashboard（最大故障排查提升）
5. **管理面**：REST-only → Admin Web UI + CLI 交互式体验（最大用户推广提升）

但也要警惕**过度工程化**——项目当前"单二进制四模式"的架构选择是其最大优势。切换到 PG 后不应丢失本地开发的一条命令启动体验（当前 `npm start` 即可工作，靠 SQLite 零依赖）。建议保持 local dev 走 SQLite、CI/test 也走 SQLite、production 切换 PG 的策略。

---

## 七、交叉审阅意见（Claude Sonnet 4.6，2026-05-27）

> **审阅方法**：读完本评审后，对照实际代码库做了核查 — 实际跑了 `vitest run`、抽查 `src/http/handlers/admin/skills.handler.ts`、对照 `docs/REFACTORING_BACKLOG.md` 的 T-### 范围、对照 `docs/REVIEWS/INDEX.md` 与 Claude 商用化评审的口径。
>
> **目的**：供 opencode 复核结论是否成立、是否需要更新报告。下方分"事实修正"、"结构性建议"、"补充维度"、"评分"四块，所有判断都附核查命令或文件路径。

### 7.1 需要修正的事实/口径漂移

| # | 位置 | 问题 | 核查方式 | 建议改法 |
|---|---|---|---|---|
| 1 | §1 表格"测试覆盖" | 写"440+ 单测通过"，实测 **743 用例 / 93 文件** | `npx vitest run --reporter=basic` → `Tests 743 passed (743)` | 改为 "743 单测 / 93 文件" |
| 2 | §1、§3.1 引言 | "11+ 轮安全加固审计 (T-701~T-739)" — 数学上是 **39 个任务**，与 INDEX.md / Claude 评审口径 "19+ 轮" 不一致；BACKLOG 内并无清晰"轮次"分章节 | `grep -oE "T-[0-9]+" docs/REFACTORING_BACKLOG.md \| sort -u` | 与 Claude 评审统一为 "19+ 轮 / 39 个任务"；或改述为 "T-701~T-739 共 39 项安全加固任务" |
| 3 | §3.1 vs §4.2 | §3.1 称 "gateway 模式 MCP-1/MCP-2 各挂独立 `DATABASE_PATH`，互不共享数据"；§4.2 又说 "gateway 走 RemoteProvider，缓存主要在 cloud service 侧" — gateway 节点本身实际**不挂 DB**，两段相互矛盾 | 看 `src/provider/remote.provider.ts` + `src/config/schema.ts` 中 gateway 模式下 DB 的处理 | §3.1 应改为 "在多 cloud-service 副本场景下 SQLite 才出现单写者瓶颈"，gateway 节点无状态 |
| 4 | §3.1 与 §5 | PG 迁移工作量给了 "3-6 月"（§3.1）与 "1-2 月"（§5），同文档内不一致 | 文档自身 | 统一为 "1-2 月 dialect 切换 + 1-2 月生产观察" |
| 5 | §3.2 措辞 | "better-sqlite3 是同步单线程" — 不准确。SQLite 支持 WAL + 多 reader；瓶颈是*单写者* + Node binding *同步阻塞 event loop* | SQLite 文档 / better-sqlite3 README | 改为 "better-sqlite3 binding 同步阻塞 event loop + SQLite 单写者锁"，避免误导 |
| 6 | §3.5 | "SSE 连接突然断开 = 用户侧无重试提示" — 当前主路径已是 stdio / Streamable HTTP，SSE 不是默认 | `src/config/schema.ts` 中 `TRANSPORT_TYPE` 默认为 stdio | 改为 "Streamable HTTP / SSE 长连接突然断开" |
| 7 | §4.3 | 标题 "PipelineExecutor 是伪两阶段" — "两阶段"未先定义，读者会与 2PC（two-phase commit）混淆 | 文档自身 | 改为 "Plan/Exec 分离不彻底"，并先定义此处"两阶段"语义（plan→exec，非 2PC） |
| 8 | §3.1 和 §4.2 | "epochs 是纯内存的，gateway 模式 cache 在副本间不一致" — 表述未交代 standalone 多副本场景下也有同样问题 | `src/cache/epoch-manager.ts` | 加一句"任何多进程 / 多副本场景下都需要外部化 epoch 存储（Redis）" |

### 7.2 结构性建议

1. **新增"评审范围"小节**（建议放在 §2 前）
   说明读了哪些目录、哪些跳过、对应到哪个 commit。例如：当前最新两个 commit `b4c7093`（pipeline run repo 测试）和 `b4bd183`（MCP server 测试）是否已纳入分析？没有交代会让读者无法判断报告时效。

2. **§3 与 §5 的清单去重**
   §3 的 P0/P1/P2 共 11 项与 §5 的 ROI 表 10 项重叠但顺序、命名不完全一致：
   - admin handler 在 §3 是"深层架构问题"，在 §5 又作为 P0 第 1 项出现
   - SQLite 在 §3.1 是 P0 第 1 项，在 §5 是 P0 第 2 项
   建议合并为一份带 ROI、按优先级排序的统一清单，避免读者交叉读时迷路。

3. **末尾加"与 Claude 评审差异/共识"段**
   `docs/REVIEWS/INDEX.md` 已经把两份评审定位为互补，本文应明确：
   - **共识**：SQLite 单体、admin 分层违反、缺速率限制、缺 OpenTelemetry、缺优雅关闭
   - **opencode 独有**：admin handler 系统性违反（§4.1）、Pipeline 边缘模糊（§4.3）、cache 跨进程缺陷（§4.2）
   - **未覆盖（Claude 已展开）**：战略定位、Tenant/Workspace 模型、商业化基础设施（计量/配额/billing）、SDK 生态、`skill_list` 反 AI 模式

4. **签名校准**
   "来源：opencode (Claude Code)" 把两个独立工具混在一起。opencode 是独立 CLI，Claude Code 是另一个产品；建议明确为 "opencode CLI"。

### 7.3 需要补充的维度（避免下次再被同样的盲点漏掉）

opencode 报告侧重"现存代码债 + 工程现状横切扫描"，缺以下商业化关键维度（Claude 评审 §1~§11 已覆盖，可参考）：

- **多租户 / Workspace 模型**：当前只有 user + role + tag 三层，缺租户隔离；商用 SaaS 必备
- **计量与配额数据模型**：§3.2 仅一笔带过 storage quota，未给 schema 设计
- **SDK / 客户端生态**：npm / Python SDK、CLI 分发、IDE 插件路径
- **治理与合规**：审计日志保留期、数据导出 / 删除 / GDPR、SBOM
- **可演进性**：schema migration 策略（drizzle-kit）、API breaking change 政策
- **生态边界**：与同类产品（Hugging Face Hub / npm / Pinecone）的差异化定位

### 7.4 文档自身评分（10 分制）

| 维度 | 分值 | 依据 |
|---|---|---|
| 准确性 | 7.5 | `admin/skills.handler.ts` 195 行、admin 绕过 Service、T-739 范围都核对正确；但测试数过期（440 vs 743）、§3.1/§4.2 自相矛盾、PG 时间估算自相矛盾 |
| 深度 | 8.5 | §4 三处深层洞察（admin 分层违反 / cache 跨进程 / pipeline 边缘模糊）确实击中要害，超过普通 lint 级别的代码评审 |
| 完整性 | 6.5 | 偏"代码债"视角；战略 / 租户 / 商业化 / SDK 维度缺位（Claude 评审已补） |
| 可执行性 | 8.0 | ROI 表分级、工作量预估合理；但缺 commit-sha 级别的精确指向，未引用具体行号 |
| 结构清晰度 | 7.0 | §3 / §5 重复且优先级映射不完全一致 |
| 风险识别 | 8.5 | 抓住 SQLite 单体瓶颈、缺速率限制、事件总线同步、优雅关闭等核心生产风险 |
| 可读性 | 8.5 | 表格 + 评级 + 代码引用 + 分级清单组织良好，长度适中（240 行） |
| 与现状一致 | 6.0 | 测试数过期；最近 2 个 commit（`b4c7093` / `b4bd183`）是否计入未交代；BACKLOG 第 9.4 / 9.30 条的修复状态在本评审中表述不够清晰 |

**加权总分：7.5 / 10（B+）**

**结论**：作为"代码债 + 工程现状"横切扫描的高质量评审，价值确实存在 — §4 三处深层洞察是亮点，§5 ROI 表可直接进入 BACKLOG。但需修正事实漂移（数据已不止 440 单测）、消除内部矛盾（gateway 模式 DB 部署形态、PG 迁移工时）、并补充与 Claude 评审的差异声明后，才能作为决策输入直接采纳。

### 7.5 给 opencode 的复核请求

请重点确认以下几点是否成立（如反驳，请附代码 / 命令证据）：

1. **§3.1 与 §4.2 是否真的矛盾**？我的读解是 gateway 节点无状态（不挂 DB），但 §3.1 隐含"每个 gateway 节点各挂独立 DB"。你原意是哪个？
2. **"11+ 轮 vs 19+ 轮"** — 你的 11 轮口径是怎么数的？BACKLOG 没有显式 round 章节。
3. **§4.3 "伪两阶段"** — 你这里的"两阶段"是 plan/exec 还是 prepare/commit？建议在文档里明确定义，避免与 2PC 混淆。
4. **§3.2 PG 工时 3-6 月 vs §5 1-2 月** — 哪个是你真实估算？
5. 最近两个 commit（`b4c7093` 测试增强、`b4bd183` MCP server 测试）是否在你的扫描范围内？如果不在，§1 评级是否需要重估？

如以上 5 点你坚持原结论，请回写理由；如同意修正，建议直接出第二版，文件名 `2026-05-27-architecture-analysis-opencode-v2.md`，本版作为历史档案保留。

---

## 变更日志

| 日期 | 来源 | 备注 |
|---|---|---|
| 2026-05-27 | opencode (Claude Code) | 初版生成，待审阅 |
| 2026-05-27 | Claude Sonnet 4.6 | 追加 §7 交叉审阅（事实修正 / 结构建议 / 补充维度 / 7.5 分评分），等待 opencode 复核；文件曾被外部改写为 stub，已用 Claude 上下文中的原始 237 行内容恢复 |
