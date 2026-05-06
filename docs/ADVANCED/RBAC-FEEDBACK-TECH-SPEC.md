# 技能权限管控与反馈闭环 — 技术方案

## 概述

本文档定义 skill-mcp 项目的权限管控、标签过滤、远程只读提示、会话追踪及技能反馈闭环的完整技术方案。旨在将当前"无权限的技能仓库"升级为"按用户权限过滤、可追踪、可度量"的 Agent 能力平台。

### 核心需求

| # | 需求 | 一句话描述 |
|---|------|-----------|
| 1 | 权限管控 | 用户通过 token 认证，服务端按权限过滤技能 |
| 2 | 远程只读 | 技能内容不在 Agent 端持久存储，仅运行时加载 |
| 3 | 标签过滤 | skill_list 支持按 tags 参数筛选，引导 Agent 精准发现 |
| 4 | 会话追踪 | userId + sessionId 贯穿全链路 |
| 5 | 反馈闭环 | skill_feedback tool 收集效果数据，驱动排序和改进 |

### 设计原则

- **低成本高可用** — 复用现有 `skills.tags` 字段，不引入额外复杂度
- **渐进式改造** — 四个 Phase 递进，每阶段独立可交付
- **不破坏兼容** — 无 token 时降级为公开技能访问，现有部署不受影响

---

## 一、现状诊断

当前权限相关代码存在 5 个致命缺陷：

| # | 缺陷 | 位置 | 影响 |
|---|------|------|------|
| 1 | `NoopPermissionFilter` 硬编码 | `src/cli/commands/serve-cmd.ts:79` | 所有权限检查空操作 |
| 2 | `GroupPermissionFilter.check()` 永远返回 true | `src/permission/group-filter.ts:28-30` | viewSkillEntry/readSkillsFiles 权限形同虚设 |
| 3 | API Key 中间件不提取用户身份 | `src/middleware/apikey-auth.ts` | 只验证合法性，不识别"你是谁" |
| 4 | Gateway API 绕过权限过滤 | `src/app.ts:496-524` | 直接调用 skillProvider，不走 SkillService |
| 5 | 访问日志无 userId/sessionId | `src/db/schema.ts:accessLogs` | 无法审计和追踪 |

---

## 二、权限模型：Tag → 角色 → 用户

### 2.1 模型定义

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Tag(标签)  │ ←── │  Role(角色)  │ ←── │  User(用户)  │
│  = 能力单元  │     │  = tag集合   │     │  = 平台注册   │
└─────────────┘     └─────────────┘     └─────────────┘
```

- **Tag**：能力标签。技能通过 `skills.tags` 字段声明自己提供的能力（复用现有字段，无需新增）
- **Role**：角色，tag 的集合。一个角色代表一组能力的授权包
- **User**：用户，绑定一个或多个角色。通过平台注册获得 token

**权限匹配规则**：

```
skill.tags = []              → 公开技能，所有用户可访问
skill.tags ∩ user.tags ≠ ∅  → 受控技能，用户拥有至少一个匹配标签时可访问
skill.tags ∩ user.tags = ∅  → 无权访问，skill_list 不展示，skill_view 拒绝
```

### 2.2 数据模型

#### 新增表：users

```typescript
const users = sqliteTable("users", {
  id: text("id").primaryKey(),              // UUID
  name: text("name"),                       // User display name
  token: text("token").notNull().unique(),  // SHA-256(token), used for authentication
  status: text("status").default("active"), // active / disabled
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
}, (table) => [
  index("idx_users_token").on(table.token),
]);
```

#### 新增表：roles

```typescript
const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),    // e.g. "data-team", "ops-team"
  description: text("description"),
  tags: text("tags").notNull(),             // JSON array — tag set this role grants
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
});
```

#### 新增表：user_roles

```typescript
const userRoles = sqliteTable("user_roles", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  createdAt: integer("created_at"),
}, (table) => [
  index("idx_user_roles_user_id").on(table.userId),
]);
```

#### 变更表：access_logs

```typescript
// Add two new columns to existing accessLogs table
userId: text("user_id"),          // From RequestContext
sessionId: text("session_id"),    // From RequestContext
```

#### 复用：skills.tags

现有 `skills.tags` 字段（JSON array）直接作为权限匹配的输入，无需修改。

### 2.3 认证流程

**纯 Token 认证**（不使用 ak/sk）：

```
请求到达
  → 提取 Authorization: Bearer <token>
  → SHA-256(token) → UserRepository.findByToken(hash)
  → 获取 userId
  → 查询 userRoles JOIN roles → 聚合所有 tag
  → 构建 RequestContext { userId, sessionId, tags }
  → 传递给 SkillService → TagPermissionFilter
```

**无 Token 降级**：未携带 token 的请求只能访问 `tags = []` 的公开技能。

### 2.4 RequestContext

```typescript
interface RequestContext {
  userId: string;            // User identifier ("anonymous" when no token)
  sessionId: string;         // Session identifier
  tags: Set<string>;         // All capability tags this user possesses
  isAuthenticated: boolean;  // Whether authenticated via token
}
```

**sessionId 生成与传递机制**：

MCP SDK 的 `ToolCallback` 签名为 `(args, extra: RequestHandlerExtra) => result`，其中 `extra.sessionId` 由 SDK 自动注入。当前所有 tool handler 忽略了 `extra` 参数（`src/mcp/tools/skill-list.ts:10` 签名为 `async ()`），sessionId 未被使用。

| Transport | sessionId 来源 | 生命周期 |
|-----------|---------------|---------|
| Streamable HTTP | SDK 内部通过 `sessionIdGenerator` 回调生成（`src/app.ts:103`） | 每次连接唯一，SDK 通过 set-cookie 管理 |
| SSE | SDK 从 SSEServerTransport 获取（`src/app.ts:120` 手动 `crypto.randomUUID()`） | 每个 SSE 连接唯一 |
| stdio | SDK 为每个连接自动生成 | 连接生命周期内不变 |
| HTTP API（非 MCP） | 请求头 `X-Session-Id` 或生成 `crypto.randomUUID()` | 每次请求唯一 |

**改造方案 — tool handler 接收 extra 参数**：

```typescript
// 当前（忽略 extra，src/mcp/tools/skill-list.ts:10）
handler: async () => { ... }

// 改造后（提取 sessionId，构建 RequestContext）
handler: async (params, extra) => {
  const context = await buildRequestContext(extra);
  const result = await skillService.listSkillsIndex(context);
  return { content: [{ type: "text", text: result }] };
}
```

**buildRequestContext 实现**：

```typescript
// src/permission/context-builder.ts（新增）

async function buildRequestContext(
  extra: RequestHandlerExtra,
  userRepo: UserRepository,
  roleRepo: RoleRepository,
): Promise<RequestContext> {
  // sessionId 直接从 SDK extra 获取
  const sessionId = extra.sessionId ?? crypto.randomUUID();

  // userId 从 extra.authInfo 获取（SDK 支持），或降级为 anonymous
  const token = extra.authInfo?.token;
  if (!token) {
    return { userId: "anonymous", sessionId, tags: new Set(), isAuthenticated: false };
  }

  const hash = sha256(token);
  const user = await userRepo.findByToken(hash);
  if (!user || user.status !== "active") {
    return { userId: "anonymous", sessionId, tags: new Set(), isAuthenticated: false };
  }

  const tags = await roleRepo.getAggregatedTagsByUserId(user.id);
  return { userId: user.id, sessionId, tags: new Set(tags), isAuthenticated: true };
}
```

**HTTP API 场景（非 MCP，如 Gateway API）**：

```typescript
// src/app.ts 中 HTTP 路由处理
const sessionId = (req.headers["x-session-id"] as string) || crypto.randomUUID();
const token = extractBearerToken(req);
const context = await buildRequestContextFromHttp(token, sessionId);
```

**全链路传递**：

```
MCP tool call → extra.sessionId (SDK 自动注入)
             → buildRequestContext(extra) → RequestContext
             → SkillService(context) → TagPermissionFilter(context.tags)
             → AccessLog(context.userId, context.sessionId)
             → SkillFeedback(context.userId, context.sessionId)

HTTP API 请求 → req.headers["x-session-id"] || crypto.randomUUID()
             → buildRequestContextFromHttp(token, sessionId) → RequestContext
             → 同上
```

### 2.5 TagPermissionFilter

替代现有 `NoopPermissionFilter`，实现基于标签的权限过滤：

```typescript
class TagPermissionFilter implements IPermissionFilter {
  constructor(private context: RequestContext) {}

  async filter(skills: SkillMeta[]): Promise<SkillMeta[]> {
    return skills.filter(skill => this.canAccess(skill));
  }

  async check(skillId: string): Promise<boolean> {
    // check() requires skill info; SkillService resolves skill first then judges
    // This method is no longer used independently in TagPermissionFilter
    return true;
  }

  private canAccess(skill: SkillMeta): boolean {
    const skillTags = Array.isArray(skill.tags) ? skill.tags : [];
    if (skillTags.length === 0) return true;          // No tags = public
    if (!this.context.isAuthenticated) return false;   // Unauthenticated = public only
    return skillTags.some(t => this.context.tags.has(t));
  }
}
```

**重要**：每次请求构建新的 `TagPermissionFilter` 实例（因为 RequestContext 是请求级别的），而不是像现在一样在 `serve-cmd.ts` 中创建一个全局实例。

### 2.6 缓存策略：基于用户维度的缓存 key

**技能列表**：按用户 ID 缓存

```typescript
// 已认证用户：按 userId 缓存，每个用户独立一份
const cacheKey = `skill:list:${context.userId}`;

let skills = await cache.get<SkillMeta[]>(cacheKey);
if (!skills) {
  const allSkills = await this.skillProvider.listSkills();
  skills = await permissionFilter.filter(allSkills);
  await cache.set(cacheKey, skills, 600); // 10 分钟 TTL
}
```

**匿名用户**（未认证）：

```typescript
// 匿名用户只访问公开技能，使用固定 key
const cacheKey = "skill:list:anonymous";
```

**技能内容**：按 slug 缓存，不变

```typescript
// 同 slug 内容对所有用户相同，权限只决定"能不能看到"
const cacheKey = `skill:entry:${slug}`; // 现有逻辑不变
```

**缓存失效**：用户角色变更时，清除该用户的缓存

```typescript
// 用户角色变更时：清除该用户的技能列表缓存
await cache.delete(`skill:list:${userId}`);

// 角色被删除或 tag 变更时：清除所有拥有该角色用户的缓存
// 可通过 user_roles 表查询受影响的 userId，逐个清除
const affectedUserIds = await userRoleRepo.findUserIdsByRoleId(roleId);
for (const uid of affectedUserIds) {
  await cache.delete(`skill:list:${uid}`);
}
```

**为什么按 userId 缓存而非全量 + 内存过滤**：
- 每个用户的权限结果独立缓存，命中后无需再过滤
- 缓存 key 语义清晰，`skill:list:{uid}` 一目了然
- 缓存失效精确到用户，角色变更只影响相关用户
- 用户量通常可控（几十到几千），缓存压力不大

---

## 三、skill_list 标签过滤

### 3.1 inputSchema 改造

**当前**：`z.object({})` — 无参数

**目标**：

```typescript
z.object({
  tags: z.array(z.string()).optional().describe(
    "Filter skills by capability tags. Omit to return all accessible skills. " +
    "See available tags in the tag directory from first skill_list() call"
  ),
})
```

### 3.2 服务端过滤逻辑

```typescript
async listSkillsIndex(context: RequestContext, tags?: string[]): Promise<string> {
  // Step 0: 按用户 ID 缓存权限过滤结果
  const cacheKey = `skill:list:${context.userId}`;
  let skills = await cache.get<SkillMeta[]>(cacheKey);
  if (!skills) {
    const allSkills = await this.skillProvider.listSkills();
    const filter = new TagPermissionFilter(context);
    skills = await filter.filter(allSkills);
    await cache.set(cacheKey, skills, 600); // 10 分钟 TTL
  }

  // Step 1: 标签过滤（按请求参数）
  if (tags && tags.length > 0) {
    skills = skills.filter(s => {
      const skillTags = Array.isArray(s.tags) ? s.tags : [];
      return tags.some(t => skillTags.includes(t));
    });
  }

  // Step 2: 仅展示 published
  skills = skills.filter(s => s.status === "published");

  // Step 3: 排序（Phase 2 加入效果排序）
  skills.sort((a, b) => a.slug.localeCompare(b.slug));

  // Step 4: 格式化
  const lines = skills.map(s => {
    const desc = (s.description ?? "").length > 80
      ? s.description.slice(0, 77) + "..."
      : s.description;
    return `    - ${s.slug} [id:${s.id}]: ${desc}`;
  });

  return lines.join("\n");
}
```

### 3.3 提示词改造

`src/prompt/descriptions.ts` 中 `SKILL_LIST_DESC` 改造为：

```
【Must-Check Resource】List all available extension skills (slug, id, and brief description).

These are extension skills provided via MCP and should be used alongside built-in skills.

On first conversation, call skill_list() to get the full list and learn all available tags.
For subsequent requests, call skill_list({tags: ["relevant-tag"]}) to narrow down
and get more precise matches.

Examples:
- User asks about code review → skill_list({tags: ["code-review"]})
- User asks about cache issues → skill_list({tags: ["debugging", "cache"]})
- Uncertain → skill_list() returns all

It's better to load a skill you don't need than to miss one you might need.
Skills contain specialized workflows, API usage, and known pitfalls that
significantly outperform generic approaches.
List format: - slug [id:uuid]: description. Use skill_view(slug) or skill_view(id) to load.
```

### 3.4 MCP instructions 注入标签目录

`src/mcp/server.ts` 中 `createMcpServer()` 改造，在 instructions 末尾追加可用标签目录：

```typescript
export async function createMcpServer(
  skillService: SkillService,
  skillProvider: ISkillProvider,
  serverName?: string,
  serverVersion?: string,
): Promise<McpServer> {
  const skills = await skillProvider.listSkills();
  let instructions = buildSkillSystemPrompt(skills);

  // 追加标签目录
  const allTags = new Set<string>();
  for (const skill of skills) {
    if (Array.isArray(skill.tags)) {
      skill.tags.forEach(t => allTags.add(t));
    }
  }
  if (allTags.size > 0) {
    instructions += `\n\n[Available tags: ${[...allTags].sort().join(", ")}]`;
    instructions += `\nCall skill_list({tags: ["tag"]}) to filter skills by tag.`;
  }

  const server = new McpServer(
    { name: serverName ?? "skill-mcp", version: serverVersion ?? "0.0.1" },
    { instructions },
  );

  registerTools(server, skillService);
  return server;
}
```

---

## 四、远程只读提示

### 4.1 设计说明

当前 Gateway 模式下，Agent（Claude 等）通过 MCP 调用 skill_view/skill_file 时，内容仅进入对话上下文（内存），对话结束后自然消失。Agent 端没有文件系统写入。**架构天然就是远程只读的。**

需要解决的是"显式提示"：在 skill_view 返回内容末尾追加提示，提醒 Agent 严禁落盘。

### 4.2 实现

**改造位置**：`src/services/skill.service.ts:viewSkillEntry()` 返回内容

**当前返回**：
```
[SYSTEM: The user is using the "xxx" skill. ...]
... SKILL.md content ...
[Available files: ...]
[Tip: Use skill_file(...)]
```

**改造后**：
```
[SYSTEM: The user is using the "xxx" skill. ...]
... SKILL.md content ...
[Available files: ...]
[Tip: Use skill_file(...)]
[REMOTE-READ-ONLY: This skill content is for runtime use only. Do NOT persist to local storage! Content will not be saved; reload on next use.]
```

**代码变更**：在 `viewSkillEntry()` 返回数组的 `filter(Boolean).join("\n")` 前追加一行：

```typescript
return [
  `[SYSTEM: The user is using the "${skill.slug}" skill. Below are the full instructions. Follow them strictly.]`,
  "",
  content,
  "",
  filePaths ? `[Available files: ${filePaths}]` : "",
  filePaths ? `[Tip: Use skill_file("${skill.slug}", ["path1", "path2"]) to batch-load files]` : "",
  "[REMOTE-READ-ONLY: This skill content is for runtime use only. Do NOT persist to local storage! Content will not be saved; reload on next use.]",
].filter(Boolean).join("\n");
```

---

## 五、技能效果反馈闭环

### 5.1 新增 MCP tool：skill_feedback

```typescript
// src/mcp/tools/skill-feedback.ts

export function createSkillFeedbackTool(skillService: SkillService) {
  return {
    name: "skill_feedback" as const,
    description: SKILL_FEEDBACK_DESC,
    inputSchema: z.object({
      skill_slug: z.string().describe("Skill slug"),
      outcome: z.enum(["success", "partial", "failure", "irrelevant"])
        .describe("Result: success=fully succeeded, partial=partially succeeded, failure=failed, irrelevant=not applicable"),
      context: z.string().describe("Brief description of the usage scenario"),
      agent_comment: z.string().describe("Agent self-assessment, e.g. whether skill instructions were clear and steps were effective"),
    }),
    handler: async (input: { skill_slug: string; outcome: string; context: string; agent_comment: string }) => {
      await skillService.submitFeedback(input);
      return {
        content: [{
          type: "text" as const,
          text: `Feedback recorded for skill "${input.skill_slug}": ${input.outcome}`,
        }],
      };
    },
  };
}
```

**提示词**（descriptions.ts 新增）：

```
【Effect Feedback】After completing a task using a skill, call this tool to report the result.
This helps improve skill quality and recommendation ranking. Report honestly.

Example:
skill_feedback({
  skill_slug: "product-analyzer",
  outcome: "success",
  context: "Analyzed product cache inconsistency issue",
  agent_comment: "Skill steps were clear, successfully identified the problem"
})
```

**注册**：在 `src/mcp/tools/registry.ts` 中新增注册。

### 5.2 数据模型

```typescript
const skillFeedbacks = sqliteTable("skill_feedbacks", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  skillSlug: text("skill_slug").notNull(),
  userId: text("user_id"),               // 来自 RequestContext
  sessionId: text("session_id"),         // 来自 RequestContext
  outcome: text("outcome").notNull(),    // success / partial / failure / irrelevant
  context: text("context"),
  agentComment: text("agent_comment"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_feedbacks_skill_slug").on(table.skillSlug),
  index("idx_feedbacks_created_at").on(table.createdAt),
]);
```

### 5.3 Repository

```typescript
// src/db/repositories/skill-feedback.repository.ts

export class SkillFeedbackRepository {
  constructor(private db: Database) {}

  async create(entry: Omit<SkillFeedbackEntry, "id" | "createdAt">): Promise<string> { ... }

  async findBySlug(slug: string, days?: number): Promise<SkillFeedbackEntry[]> { ... }

  async getEffectivenessRates(days?: number): Promise<Map<string, { rate: number; count: number }>> { ... }
}
```

### 5.4 有效使用率计算

```typescript
async getSkillEffectivenessRate(slug: string, days = 30): Promise<number> {
  const feedbacks = await feedbackRepo.findBySlug(slug, days);
  if (feedbacks.length === 0) return 0.5; // 无数据时默认中间值，不影响排序

  const successCount = feedbacks.filter(f =>
    f.outcome === "success" || f.outcome === "partial"
  ).length;

  return successCount / feedbacks.length;
}
```

### 5.5 排序注入

在 `listSkillsIndex()` 中，按有效使用率排序（高 → 低），使优质技能排在前面：

```typescript
// Phase 2 在 listSkillsIndex() 中新增排序逻辑
const effectivenessMap = new Map<string, number>();
for (const skill of skills) {
  effectivenessMap.set(skill.slug, await this.getSkillEffectivenessRate(skill.slug));
}
skills.sort((a, b) => {
  const rateA = effectivenessMap.get(a.slug) ?? 0.5;
  const rateB = effectivenessMap.get(b.slug) ?? 0.5;
  return rateB - rateA; // 高有效使用率排前面
});
```

### 5.6 低效技能报告 API

```
GET /api/admin/skills/effectiveness-report?days=30
```

返回示例：

```json
{
  "success": true,
  "data": {
    "report": [
      {
        "slug": "product-analyzer",
        "effectiveness": 0.92,
        "feedback_count": 50,
        "recommendation": "表现优秀"
      },
      {
        "slug": "old-debug-tool",
        "effectiveness": 0.15,
        "feedback_count": 20,
        "recommendation": "考虑下架或重写"
      }
    ],
    "generated_at": "2026-04-29T12:00:00Z"
  }
}
```

**推荐逻辑**：

| 有效使用率 | 反馈数量 | 推荐动作 |
|-----------|---------|---------|
| ≥ 0.8 | 任意 | 表现优秀 |
| 0.5 ~ 0.8 | 任意 | 需要关注 |
| < 0.5 | ≥ 10 | 考虑下架或重写 |
| < 0.5 | < 10 | 数据不足，继续观察 |

---

## 六、用户与角色管理

用户和角色管理同时支持 **Admin API** 和 **CLI 命令**两种操作方式，适应不同场景：
- API：适合 Web 管理后台、自动化脚本、远程运维
- CLI：适合本地开发、快速调试、CI/CD 流水线

### 6.1 用户管理

#### API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/admin/users` | GET | 列出所有用户（分页） |
| `/api/admin/users` | POST | 注册用户（生成 token） |
| `/api/admin/users/{id}` | GET | 获取用户详情（含角色和标签） |
| `/api/admin/users/{id}` | PUT | 更新用户信息 |
| `/api/admin/users/{id}` | DELETE | 删除用户 |
| `/api/admin/users/{id}/roles` | PUT | 分配角色（替换整个角色列表） |

**注册用户请求体**：

```json
{
  "name": "张三",
  "role_ids": ["role-uuid-1", "role-uuid-2"]
}
```

**注册用户响应**（token 仅在创建时返回一次）：

```json
{
  "success": true,
  "data": {
    "id": "user-uuid",
    "name": "张三",
    "token": "sk-live-xxxxxxxxxxxx",
    "roles": ["data-team", "ops-team"],
    "tags": ["analysis", "debugging", "cache"]
  }
}
```

#### CLI 命令

```bash
# 注册用户（返回 token，仅显示一次）
skill-mcp user create --name "张三" --roles "data-team,ops-team"

# 列出所有用户
skill-mcp user list

# 查看用户详情（含角色和有效标签）
skill-mcp user info <user-id>

# 更新用户信息
skill-mcp user update <user-id> --name "李四"

# 删除用户
skill-mcp user remove <user-id> --force

# 分配角色（替换整个角色列表）
skill-mcp user assign-roles <user-id> --roles "data-team,ops-team"

# 重新生成 token（旧 token 立即失效）
skill-mcp user regenerate-token <user-id>
```

**CLI 输出示例**：

```
$ skill-mcp user create --name "张三" --roles "data-team"
✓ Created user:
  ID:       user-uuid
  Name:     张三
  Token:    sk-live-a1b2c3d4e5f6  (请妥善保管，仅显示一次)
  Roles:    data-team
  Tags:     analysis, debugging, cache
```

### 6.2 角色管理

#### API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/admin/roles` | GET | 列出所有角色 |
| `/api/admin/roles` | POST | 创建角色 |
| `/api/admin/roles/{id}` | GET | 获取角色详情 |
| `/api/admin/roles/{id}` | PUT | 更新角色（修改 tag 集合） |
| `/api/admin/roles/{id}` | DELETE | 删除角色 |

**创建角色请求体**：

```json
{
  "name": "data-team",
  "description": "数据分析团队",
  "tags": ["analysis", "debugging", "cache"]
}
```

#### CLI 命令

```bash
# 创建角色
skill-mcp role create --name "data-team" --description "数据分析团队" --tags "analysis,debugging,cache"

# 列出所有角色
skill-mcp role list

# 查看角色详情
skill-mcp role info <role-id>

# 更新角色（修改 tag 集合）
skill-mcp role update <role-id> --tags "analysis,debugging,cache,monitoring"

# 删除角色（同时解除所有用户的该角色绑定）
skill-mcp role remove <role-id> --force
```

**CLI 输出示例**：

```
$ skill-mcp role list
Found 3 role(s):

  data-team     [analysis, debugging, cache]        2 users
  ops-team      [monitoring, alerting]              5 users
  all-skills    [*]                                  1 users
```

### 6.3 CLI 命令注册

在 `src/cli/index.ts` 中新增 `user` 和 `role` 子命令组：

```typescript
// src/cli/commands/user-cmd.ts
program
  .command("user")
  .description("Manage users and tokens")
  .addCommand(
    new Command("create").description("Create a new user")
      .requiredOption("--name <name>", "User name")
      .option("--roles <role-ids>", "Comma-separated role IDs")
      .action(async (opts) => { /* ... */ })
  )
  .addCommand(new Command("list").description("List all users").action(/* ... */))
  .addCommand(new Command("info <id>").description("Show user details").action(/* ... */))
  .addCommand(new Command("update <id>").description("Update user").action(/* ... */))
  .addCommand(new Command("remove <id>").description("Remove user").action(/* ... */))
  .addCommand(new Command("assign-roles <id>").description("Assign roles").action(/* ... */))
  .addCommand(new Command("regenerate-token <id>").description("Regenerate token").action(/* ... */));

// src/cli/commands/role-cmd.ts
program
  .command("role")
  .description("Manage roles and permissions")
  .addCommand(
    new Command("create").description("Create a new role")
      .requiredOption("--name <name>", "Role name")
      .option("--description <desc>", "Description")
      .requiredOption("--tags <tags>", "Comma-separated tags")
      .action(async (opts) => { /* ... */ })
  )
  .addCommand(new Command("list").description("List all roles").action(/* ... */))
  .addCommand(new Command("info <id>").description("Show role details").action(/* ... */))
  .addCommand(new Command("update <id>").description("Update role").action(/* ... */))
  .addCommand(new Command("remove <id>").description("Remove role").action(/* ... */));
```

---

## 七、实施路线

### Phase 1：身份 + 权限 + 会话追踪（2-3 周）

| # | 任务 | 改动文件 | 说明 |
|---|------|---------|------|
| 1.1 | 新增 users / roles / user_roles 表 | `src/db/schema.ts` | 数据库表定义 |
| 1.2 | 新增数据库迁移 | `src/db/migrations/` | 建表 + access_logs 加字段 |
| 1.3 | 新增 UserRepository | `src/db/repositories/user.repository.ts` | 用户 CRUD + findByToken |
| 1.4 | 新增 RoleRepository | `src/db/repositories/role.repository.ts` | 角色 CRUD + 按用户聚合 tags |
| 1.5 | 新增 UserRoleRepository | `src/db/repositories/user-role.repository.ts` | 用户-角色关联 CRUD |
| 1.6 | 新增 RequestContext 类型 | `src/types/index.ts` | userId + sessionId + tags + isAuthenticated |
| 1.7 | 新增 buildRequestContext | `src/permission/context-builder.ts` | 从 MCP SDK `extra.sessionId` 提取 sessionId，token→userId→tags 构建 RequestContext |
| 1.8 | 新增 TagPermissionFilter | `src/permission/tag-filter.ts` | 替代 NoopPermissionFilter，请求级实例 |
| 1.9 | SkillService 支持 RequestContext | `src/services/skill.service.ts` | 方法签名增加 context 参数 |
| 1.10 | MCP tool handler 接收 extra 参数 | `src/mcp/tools/*.ts` | handler 签名改为 `(params, extra)`，调用 buildRequestContext(extra) 构建 context 后传递给 SkillService |
| 1.11 | serve-cmd 移除 NoopPermissionFilter | `src/cli/commands/serve-cmd.ts` | 权限过滤改为请求级，每次请求创建 TagPermissionFilter |
| 1.12 | Gateway API 应用权限过滤 | `src/app.ts` | 修复绕过问题；HTTP 路由从 `X-Session-Id` 头或 `crypto.randomUUID()` 获取 sessionId，构建 RequestContext |
| 1.13 | 访问日志增加 userId + sessionId | `src/db/schema.ts` + 服务层 | 全链路追踪 |
| 1.14 | skill_view 追加远程只读提示 | `src/services/skill.service.ts` | [REMOTE-READ-ONLY] |
| 1.15 | 缓存 key 改为用户 ID 维度 | `src/services/skill.service.ts` | `skill:list:{uid}` 按用户缓存，匿名用户单独 key |
| 1.16 | Admin API：用户管理 | `src/app.ts` | CRUD + token 生成 |
| 1.17 | Admin API：角色管理 | `src/app.ts` | CRUD + tag 分配 |
| 1.18 | CLI：user 子命令组 | `src/cli/commands/user-cmd.ts` | create/list/info/update/remove/assign-roles/regenerate-token |
| 1.19 | CLI：role 子命令组 | `src/cli/commands/role-cmd.ts` | create/list/info/update/remove |
| 1.20 | 无 token 降级逻辑 | 各处 | anonymous 用户仅访问公开技能 |

### Phase 2：标签过滤 + 反馈闭环（2 周）

| # | 任务 | 改动文件 | 说明 |
|---|------|---------|------|
| 2.1 | skill_list 增加 tags 参数 | `src/mcp/tools/skill-list.ts` | inputSchema 改造 |
| 2.2 | SkillService.listSkillsIndex 支持 tags | `src/services/skill.service.ts` | 服务端标签过滤 |
| 2.3 | 提示词改造 | `src/prompt/descriptions.ts` | 引导 Agent 传入标签 |
| 2.4 | MCP instructions 注入标签目录 | `src/mcp/server.ts` | 可用标签列表 |
| 2.5 | 新增 skill_feedbacks 表 | `src/db/schema.ts` | 反馈数据模型 |
| 2.6 | 新增 SkillFeedbackRepository | `src/db/repositories/skill-feedback.repository.ts` | 反馈 CRUD + 统计 |
| 2.7 | 新增 skill_feedback MCP tool | `src/mcp/tools/skill-feedback.ts` | Agent 反馈调用 |
| 2.8 | 注册 skill_feedback | `src/mcp/tools/registry.ts` | 工具注册 |
| 2.9 | 有效使用率计算 + 排序 | `src/services/skill.service.ts` | skill_list 按效果排序 |
| 2.10 | 低效技能报告 API | `src/app.ts` | GET /api/admin/skills/effectiveness-report |
| 2.11 | 反馈提示词 | `src/prompt/descriptions.ts` | SKILL_FEEDBACK_DESC |

### Phase 3：加固与优化（1-2 周）

| # | 任务 | 说明 |
|---|------|------|
| 3.1 | 权限变更缓存失效 | 用户角色变更时清除 `skill:list:{uid}` 缓存，确保即时生效 |
| 3.2 | 断路器 | RemoteProvider 增加断路器，防止远程服务故障级联 |
| 3.3 | 速率限制 | Gateway API 增加每用户速率限制，防止枚举受限技能 |
| 3.4 | 运行时注入扫描 | skill_view 返回前也执行 scanForInjection，不只是 import 时 |

### Phase 4：能力升级（后续迭代）

| # | 任务 | 说明 |
|---|------|------|
| 4.1 | SkillManifest 结构化协议 | 技能从 prompt 演进为 capability（inputs/outputs/preconditions） |
| 4.2 | 内容水印 | 追踪敏感技能内容泄露源 |
| 4.3 | 语义搜索 | embedding 索引 + 上下文感知推荐 |
| 4.4 | 技能组合推荐 | 基于使用数据推荐 skill 组合 |

---

## 八、关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 认证方式 | 纯 Bearer Token | 简单够用，减少复杂度。平台注册用户时生成 token |
| 权限模型 | Tag → 角色 → 用户 | 低成本、直觉、复用现有 `skills.tags` 字段 |
| 权限粒度 | 列表级过滤 | skill_list 不展示无权技能，skill_view 双重校验 |
| 缓存策略 | 按用户 ID 缓存 | `skill:list:{uid}` 每个用户独立缓存，角色变更时精确清除 |
| 内容缓存 | 按 slug 缓存不变 | 同 slug 内容对所有用户相同，权限只控制可见性 |
| 会话追踪 | RequestContext(userId + sessionId) | 全链路贯穿，支持审计和反馈关联 |
| 远程只读 | 天然不落盘 + 显式提示 | MCP 协议 response 仅存在于对话内存 |
| 技能发现 | skill_list + tags 参数 | 利用现有标签 + 提示词引导 Agent 筛选 |
| 反馈闭环 | skill_feedback + 有效使用率排序 | 系统自我改进的核心机制 |
| 审批流程 | 不做 | 对 Agent 使用打断太大，改为权限预设 |
| 语义搜索 | 暂不做 | 标签过滤解决 80% 场景，后续迭代 |

---

## 九、配置变更

### 新增环境变量

```bash
# 用户认证（替代原 API_KEY 配置）
AUTH_TOKEN_ENABLED=true               # 启用 token 认证（默认 false）
AUTH_TOKEN_ANONYMOUS_ACCESS=true      # 允许匿名访问公开技能（默认 true）
```

### 配置 Schema 变更

```typescript
// src/config/schema.ts 新增
auth: z.object({
  enabled: z.boolean().default(false),
  anonymousAccess: z.boolean().default(true),
}).optional(),
```

---

## 十、验证方案

### Phase 1 验证

```bash
# 1. 注册用户和角色
curl -X POST http://localhost:3000/api/admin/roles \
  -H "Content-Type: application/json" \
  -d '{"name":"data-team","tags":["analysis","debugging"]}'

curl -X POST http://localhost:3000/api/admin/users \
  -H "Content-Type: application/json" \
  -d '{"name":"测试用户","role_ids":["<role-id>"]}'

# 2. 带 token 访问 Gateway API
curl http://localhost:3000/api/gateway/skills \
  -H "Authorization: Bearer <user-token>"
# 预期：只返回 tags 与用户角色匹配的技能

# 3. 无 token 访问
curl http://localhost:3000/api/gateway/skills
# 预期：只返回公开技能（tags=[]）

# 4. 访问无权技能
curl http://localhost:3000/api/gateway/skills/restricted-skill/entry \
  -H "Authorization: Bearer <user-token>"
# 预期：403 Forbidden

# 5. 检查访问日志包含 userId + sessionId
curl http://localhost:3000/api/admin/logs?skill_slug=some-skill
# 预期：日志条目包含 userId 和 sessionId

# 6. 检查 skill_view 包含远程只读提示
# 通过 MCP 客户端调用 skill_view，检查返回末尾包含 [REMOTE-READ-ONLY]
```

### Phase 2 验证

```bash
# 1. skill_list 标签过滤
# MCP 客户端调用 skill_list({tags: ["analysis"]})
# 预期：只返回包含 analysis 标签的技能

# 2. skill_feedback 反馈
# MCP 客户端调用 skill_feedback({skill_slug: "xxx", outcome: "success", ...})
# 预期：返回确认消息，数据库有记录

# 3. 有效使用率排序
# 提交多条 feedback 后调用 skill_list()
# 预期：高有效使用率技能排在前面

# 4. 低效技能报告
curl http://localhost:3000/api/admin/skills/effectiveness-report
# 预期：返回每个技能的有效使用率和推荐
```

---

## 十一、风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 现有部署无 token 认证 | 升级后所有请求变为 anonymous | `AUTH_TOKEN_ANONYMOUS_ACCESS=true` 默认允许匿名访问公开技能，兼容现有部署 |
| MCP stdio 模式无 token 传递 | stdio 无法携带 Authorization 头 | stdio 模式下通过环境变量 `MCP_AUTH_TOKEN` 传递 token |
| 权限变更缓存延迟 | 角色变更后用户仍看到旧技能列表 | Phase 3 中实现角色变更时清除 `skill:list:{uid}` 缓存 |
| skill_feedback 被恶意刷量 | 有效使用率失真 | 按 userId + sessionId 去重，同一会话同一技能只计一次 |
| token 明文传输 | 中间人攻击 | 生产环境强制 HTTPS，token 使用 SHA-256 存储不落盘 |
