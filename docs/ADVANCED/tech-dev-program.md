# 云端技能文件系统与 MCP 权限网关 — 完整技术方案

> 版本：5.0 | 日期：2026-04-24 | 状态：架构完善版
>
> 整合 PRD v2 + 遵循度优化 + 11 项架构反馈（含技能唯一标识、版本管理、属性扩展）

---

## 目录

- [1. 概述](#1-概述)
- [2. 技术选型与决策记录](#2-技术选型与决策记录)
- [3. 模型遵循度架构](#3-模型遵循度架构)
  - [3.1 遵循度原理与认知模型](#31-遵循度原理与认知模型)
  - [3.2 渐进式信息披露架构](#32-渐进式信息披露架构)
  - [3.3 Tool Description 行为引导机制](#33-tool-description-行为引导机制)
  - [3.4 系统提示词注入机制](#34-系统提示词注入机制)
  - [3.5 技能内容行为约束规范](#35-技能内容行为约束规范)
  - [3.6 SKILL.md 编写规范（纯指令，无元数据）](#36-skillmd-编写规范纯指令无元数据)
  - [3.7 激活引导与安全扫描](#37-激活引导与安全扫描)
  - [3.8 遵循度验证指标](#38-遵循度验证指标)
- [4. 部署架构：单体模式与网关-服务拆分模式](#4-部署架构单体模式与网关-服务拆分模式)
  - [4.1 模式 A：单体部署](#41-模式-a单体部署)
  - [4.2 模式 B：网关-服务拆分](#42-模式-b网关-服务拆分)
  - [4.3 两种模式对比与选择指南](#43-两种模式对比与选择指南)
  - [4.4 统一接口抽象](#44-统一接口抽象)
- [5. 传输层设计：stdio / SSE / HTTP](#5-传输层设计stdio--sse--http)
  - [5.1 三种传输协议概览](#51-三种传输协议概览)
  - [5.2 stdio 传输](#52-stdio-传输)
  - [5.3 SSE 传输](#53-sse-传输)
  - [5.4 Streamable HTTP 传输](#54-streamable-http-传输)
  - [5.5 传输层统一接口](#55-传输层统一接口)
- [6. 系统架构设计](#6-系统架构设计)
- [7. 元数据与内容职责分离](#7-元数据与内容职责分离)
  - [7.1 职责划分原则](#71-职责划分原则)
  - [7.2 服务端元数据（Server-side Metadata）](#72-服务端元数据server-side-metadata)
  - [7.3 技能包内容（Skill Package Content）](#73-技能包内容skill-package-content)
  - [7.4 元数据管理 API](#74-元数据管理-api)
- [8. 完整运行流程图与时序图](#8-完整运行流程图与时序图)
  - [8.1 系统启动与初始化流程](#81-系统启动与初始化流程)
  - [8.2 技能发现与加载时序图](#82-技能发现与加载时序图)
  - [8.3 技能执行完整流程图](#83-技能执行完整流程图)
  - [8.4 技能包导入流程（CLI + API）](#84-技能包导入流程cli--api)
  - [8.5 网关-服务拆分模式下的完整时序](#85-网关-服务拆分模式下的完整时序)
- [9. 项目结构](#9-项目结构)
- [10. 核心模块设计](#10-核心模块设计)
  - [10.1 MCP 协议层](#101-mcp-协议层)
  - [10.2 技能管理模块](#102-技能管理模块)
  - [10.3 技能导入模块（CLI + API）](#103-技能导入模块cli--api)
  - [10.4 权限过滤模块](#104-权限过滤模块)
  - [10.5 存储抽象层](#105-存储抽象层)
  - [10.6 缓存抽象层](#106-缓存抽象层)
  - [10.7 数据访问层](#107-数据访问层)
- [11. 数据模型与数据库设计](#11-数据模型与数据库设计)
- [12. MCP Tool 接口设计](#12-mcp-tool-接口设计)
- [13. 管理 REST API 设计](#13-管理-rest-api-设计)
- [14. CLI 命令设计](#14-cli-命令设计)
- [15. 配置管理](#15-配置管理)
- [16. 错误处理与日志](#16-错误处理与日志)
- [17. 部署方案](#17-部署方案)
- [18. 实施路线图](#18-实施路线图)
- [19. 扩展预留与演进路径](#19-扩展预留与演进路径)

---

## 1. 概述

### 1.1 系统定位

本系统是一个自建 MCP Server，承担双核心职责：

1. **私有技能权限网关**：对模型暴露的技能列表进行权限过滤，确保模型仅能看到和使用已被授权的技能
2. **云端技能文件系统**：通过 MCP Tool 接口，为模型提供与本地文件访问体验一致的远程技能文件读取能力，支持文件、脚本、图片、视频等全类型资源

系统采用独立进程部署，通过 MCP 标准协议（JSON-RPC 2.0）与模型宿主环境通信，支持 **stdio / SSE / HTTP** 三种传输方式。技能的执行始终在模型端完成——服务端只负责存储和分发技能文件，不参与执行逻辑。

### 1.2 关键设计决策

| 决策 | 方案 | 理由 |
|------|------|------|
| **不使用 skill:// 协议符** | 直接通过 MCP Tool 名称（skill_view / skill_file）访问 | 模型遵循度架构已通过 Tool Description 建立了清晰的访问模式；去掉 skill:// 意味着现有技能零改造成本即可接入 |
| **支持三种传输** | stdio + SSE + StreamableHTTP | 覆盖本地 CLI、Web IDE、远程 API 三种场景 |
| **CLI + API 双通道导入** | CLI 命令 + REST API 均可导入技能 | stdio 场景下无法调用 HTTP API，CLI 填补这一缺口 |
| **批量文件读取** | skill_file 支持传入路径数组，并发读取 | 减少模型-服务交互轮次，提升加载速度 |
| **双部署模式** | 单体部署 + 网关-服务拆分 | 适应「技能集中管理」和「鉴权转发」两种场景 |
| **技能唯一标识** | 使用 `slug` 作为技能唯一标识，`name` 允许重复 | 同名技能可共存（不同版本/不同提供者）；slug 暴露在索引中供模型精确定位 |
| **版本管理** | 三位语义化版本号（x.y.z），基于内容哈希检测变更 | 确保技能更新有意义；仅在内容实际变更时才允许版本升级 |
| **自定义属性** | skills 表 `attributes` JSON 字段 | 支持灵活的技能筛选和分类，不限制固定字段 |
| **索引不分组** | `<available_skills>` 不按类别分组，平铺展示 | 降低模型认知负担；分类作为可选属性用于 API 筛选 |
| **移除计费** | 完全移除计费与用量统计需求 | 聚焦核心功能，降低复杂度 |

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **遵循度优先** | 所有设计决策以「模型是否高概率遵循」为第一评判标准 |
| **零改造成本** | 现有标准技能包可直接导入，无需适配任何协议或格式要求 |
| **渐进披露** | 技能信息分三级呈现（索引→主文件→辅助文件），降低模型认知负担 |
| **抽象优先** | 存储层、缓存层、权限层均通过接口定义，支持运行时切换实现 |
| **职责分离** | 服务端元数据（slug、标签、属性、权限）与技能内容（指令、参考、模板）严格分离 |
| **元数据与内容分离** | 分类/标签由服务端管理，SKILL.md 只含指令 | 职责清晰，技能包无需为不同部署环境修改内容 |

### 1.4 MVP 范围

**包含**：
- MCP Server（stdio + SSE + HTTP 三种传输）
- 3 个 MCP Tool（skill_list / skill_view / skill_file）
- 技能发现与渐进式加载
- skill_file 批量并发读取
- 技能导入（CLI 命令 + REST API，支持本地目录和 Git 仓库）
- 单体部署模式 + 网关-服务拆分模式
- 服务端元数据管理（分类、标签、可见性）
- SQLite 元数据存储 + 本地文件缓存
- SKILL.md 安全扫描
- 访问日志

**不包含**：计费与配额管理（已完全移除）、OSS 对象存储接入（接口已预留）、文件加密存储、水印与防泄漏、技能审核工作流、用户权限与认证体系（拆分模式预留接口）

---

## 2. 技术选型与决策记录

| 决策项 | 选定方案 | 决策理由 |
|--------|---------|---------|
| 运行时 | Node.js 22+ (ESM) | TypeScript 原生支持；MCP SDK 生态最成熟 |
| 语言 | TypeScript 5.x (strict) | MCP 官方 SDK TS 优先 |
| HTTP 框架 | Fastify 5.x | 性能优；内置 Schema Validation；支持 SSE 插件 |
| MCP 协议 | @modelcontextprotocol/sdk | 官方 SDK，支持 stdio + SSE + StreamableHTTP |
| 数据库 | SQLite (better-sqlite3) | 零运维；单文件部署；元数据量级完全够用 |
| ORM | Drizzle ORM | 轻量级；SQLite 支持优秀；类型安全 |
| 缓存 | 内存 LRU + 本地文件（多级组合） | MVP 零外部依赖；接口抽象可替换 Redis |
| 对象存储 | 本地文件系统（抽象接口） | 接口兼容后续 OSS 接入 |
| CLI 框架 | commander | 成熟的 Node.js CLI 框架 |
| Git 操作 | simple-git | 轻量 Git 操作库 |
| 日志 | pino | Fastify 默认集成；JSON 结构化 |

---

## 3. 模型遵循度架构

> 本章为整个方案中**最核心**的设计章节。

### 3.1 遵循度原理与认知模型

#### 3.1.1 为什么模型遵循度是第一优先级？

本系统的本质是让模型「按照技能中预设的专业指令执行任务」。如果模型不加载技能、或加载后不按指令执行，整个系统就失去意义。

```
模型遵循度高 → 技能指令被严格执行 → 输出质量稳定可预期 → 用户信任技能系统 → 技能生态繁荣
    ↓                              ↓                           ↓
Tool Description + 系统提示  →  SKILL.md 内容质量  →  技能提供者投入意愿
```

#### 3.1.2 LLM 工具使用的 5 个认知断点

```
用户请求 → 系统提示（Background Context）
              ↓
         Tool Schema 扫描（name + description）
              ↓
         语义匹配：用户请求 vs Tool description
              ↓
    ┌──── 匹配成功 ────┐     ┌──── 无匹配 ────┐
    │ 评估优先级：       │     │ 决定：用自己的  │
    │ "必须用还是可选？" │     │ 知识直接回复    │
    └──────┬───────────┘     └────────────────┘
           │
    调用后收到 Tool Result
           │
    "我必须严格遵循，       →── 是 ──→ 严格按指令执行
     还是可用自己的理解？"     否
                              │
                           用自己的理解（遵循度失败）
```

| 断点 | 原因 | 解决策略 |
|------|------|---------|
| 断点 1：不扫描工具列表 | 系统提示太长或太弱 | 短小精悍指令 + "mandatory" 关键词 |
| 断点 2：扫描了但不匹配 | Tool Description 不够描述性 | 使用与用户意图高度相关的措辞 |
| 断点 3：匹配但判定为「可选」 | Description 用了中性语言 | 【必检资源】【技能入口】角色标签 |
| 断点 4：调用后不遵循指令 | Tool Result 没有行为约束 | 激活引导注入 |
| 断点 5：部分遵循但中途偏离 | SKILL.md 指令不够具体 | 编号步骤 + 禁止事项 + 陷阱警告 |

### 3.2 渐进式信息披露架构

#### 3.2.1 三级信息层次

```
┌─────────────────────────────────────────────────────────────────┐
│  Tier 1: 技能索引（Skills Index）                                │
│  ────────────────────────────                                  │
│  载体：MCP instructions（系统提示词）                             │
│  Token 成本：100 ~ 400 tokens                                    │
│  内容：技能 slug + 一行描述，平铺列表（不分组）                    │
│  目的：让模型在每次回复前「花 1 秒扫描」                          │
│                                                                  │
│  <available_skills>                                              │
│    - prompt-writer: 专业提示词编写与优化                          │
│    - technical-doc: 技术文档撰写                                 │
│    - code-review: 代码审查技能                                    │
│    - architecture-diagram: 生成深色主题架构图                    │
│  </available_skills>                                             │
│                                                                  │
│  注：slug 是技能的唯一标识符，用于 skill_view / skill_file 调用  │
│      即使多个技能 name 相同，slug 也不同，确保精确定位            │
└───────────────────────────┬─────────────────────────────────────┘
                            │ 模型匹配到相关技能
                            │ 调用 skill_view(skill_slug)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Tier 2: 技能主文件（Skill Entry）                               │
│  ────────────────────────────                                  │
│  载体：skill_view Tool 返回的 Tool Result                        │
│  Token 成本：500 ~ 3000 tokens                                    │
│  内容：SKILL.md 完整内容（触发条件 + 执行步骤 + 引用文件列表）    │
│  目的：让模型获得「完整的专业工作流指令」                          │
│                                                                  │
│  # Prompt Writer                                                 │
│  ## 触发条件: 编写/优化/评估提示词                               │
│  ## 执行步骤（必须严格按序执行）                                  │
│    Step 1: 需求分析                                              │
│    Step 2: 框架选择 → 参考 references/crispe-framework.md        │
│    Step 3: 起草提示词                                             │
│    Step 4: 自检 → 使用 templates/checklist.md                    │
│  ## 已知陷阱: 不要用 "you are" 开头...                           │
└───────────────────────────┬─────────────────────────────────────┘
                            │ SKILL.md 中引用了辅助文件
                            │ 调用 skill_file(skill_slug, [paths])
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Tier 3: 辅助文件（Supporting Files）                            │
│  ────────────────────────────                                  │
│  载体：skill_file Tool 返回的 Tool Result                        │
│  Token 成本：100 ~ 5000 tokens（按需、可批量并发）                │
│  内容：参考文档、模板、脚本、图片、视频                            │
│  目的：提供 Tier 2 中引用的具体参考资料                            │
│                                                                  │
│  支持批量传入多个路径，一次调用加载多个文件，减少交互轮次           │
└─────────────────────────────────────────────────────────────────┘
```

#### 3.2.2 为什么不需要 skill:// 协议符

原始设计中使用了 `skill://prompt-writer/SKILL.md` 格式的 URI 来标识云端技能文件。在引入遵循度架构后，这一层抽象变得不必要，原因：

1. **Tool Description 已经建立了访问模式**：模型通过 `skill_view` 和 `skill_file` 两个 Tool 访问技能文件，语义清晰，无需额外的 URI 协议层
2. **降低接入门槛**：现有标准技能包（如 agentskills.io 格式）可直接导入，无需为适配 skill:// 做任何改造
3. **减少模型认知负担**：skill:// 是一个需要额外解释的协议概念，去掉后模型只需理解两个 Tool 的参数语义
4. **Tool 参数天然替代 URI**：`skill_slug` + `file_path` 两个参数完全等价于 skill:// URI 的路径部分

### 3.3 Tool Description 行为引导机制

#### 3.3.1 三段式 Description 结构

```
【角色标签】一句话定义这个 Tool 的角色定位
【行为指令】明确告诉模型：什么时候用、怎么用、用什么顺序、必须做什么
【边界条件】明确告诉模型：什么情况下不该用、前置条件是什么
```

#### 3.3.2 三个 Tool 的 Description 设计

**skill_list**：
```
【必检资源】列出所有可用的云端技能索引（slug 和简短描述）。

每次回复前，你必须扫描此列表。如果有任何技能与用户请求相关
（哪怕只是部分相关），你必须先调用 skill_view 加载该技能的
完整指令，并严格按其指令执行任务。

宁可加载一个不需要的技能，也不要遗漏可能需要的技能。
技能包含专业的工作流、API 用法和已知陷阱，能显著优于通用方案。
列表中的 slug 是技能的唯一标识符，调用 skill_view 时请使用 slug。
```

**skill_view**：
```
【技能入口】加载指定技能的完整指令（SKILL.md 主文件）。

这是使用任何技能的唯一入口——你必须先调用此工具获取完整指令，
然后严格按照指令中定义的步骤和约束执行任务。
不要跳过 skill_view 直接猜测技能内容。

加载后如果指令中引用了其他文件（references/、templates/、scripts/），
再使用 skill_file 批量加载。仅在 skill_list 中发现相关技能后才调用此工具。
使用 skill_view(skill_slug) 加载技能，其中 skill_slug 为技能列表中的唯一标识符。
```

**skill_file**：
```
【辅助文件】批量读取技能包中的辅助文件（参考文档、模板、脚本、图片、视频等）。

前置条件：必须先通过 skill_view 加载技能主文件。
仅在技能指令（SKILL.md）中明确引用了某个辅助文件时才调用此工具。
不要主动遍历或猜测技能包中的文件——仅加载主文件指令中提到的文件。

支持一次传入多个文件路径以批量并发读取，减少加载轮次。
使用 skill_file(skill_slug, file_paths) 加载辅助文件。
文本文件返回内容，图片/视频以 base64 编码返回。
```

### 3.4 系统提示词注入机制

MCP 协议的 `initialize` 响应中 `instructions` 字段用于注入系统级指令。系统提示词按技能元数据中的 slug 和描述动态生成平铺索引。

```typescript
function buildSkillSystemPrompt(skills: SkillMeta[]): string {
  // 平铺列表，不分组
  const indexLines = skills
    .filter(s => s.status === "published")
    .map(s => {
      const desc = (s.description ?? "").length > 80
        ? s.description.slice(0, 77) + "..."
        : s.description;
      return `    - ${s.slug}: ${desc}`;
    });

  return [
    `## Cloud Skills (mandatory)`,
    ``,
    `Before replying, scan the skills below. If a skill matches or is even`,
    `partially relevant to the task, you MUST load it with skill_view(skill_slug)`,
    `and follow its instructions strictly. Do NOT skip loading — skills contain`,
    `specialized workflows, API commands, and proven approaches that outperform`,
    `general methods.`,
    ``,
    `If you loaded a skill but its instructions were incomplete or wrong, continue`,
    `and note the issues. Always prefer the skill's approach over your own knowledge`,
    `for the specific domain.`,
    ``,
    `<available_skills>`,
    ...indexLines,
    `</available_skills>`,
    ``,
    `### Skill usage rules:`,
    `1. Always call skill_view(skill_slug) FIRST to load the full instructions`,
    `2. Call skill_file(skill_slug, file_paths) when the skill references other files`,
    `   (pass an array of paths to batch-load multiple files)`,
    `3. After loading a skill, follow its instructions exactly — do not substitute`,
    `   your own approach`,
  ].join("\n");
}
```

### 3.5 技能内容行为约束规范

模型加载 SKILL.md 后必须遵循的约束层次：

```
┌──────────────────────────────────────────────────────────────────┐
│  第一层：触发条件（Trigger Conditions）                           │
│  告诉模型「什么时候应该使用这个技能」                               │
│  格式：列表明确所有触发场景                                       │
├──────────────────────────────────────────────────────────────────┤
│  第二层：执行步骤（Execution Steps）                              │
│  告诉模型「必须按什么顺序做什么」                                   │
│  格式：编号步骤 + 「必须严格按序执行」                             │
├──────────────────────────────────────────────────────────────────┤
│  第三层：已知陷阱（Known Pitfalls）                               │
│  告诉模型「不要做什么」——对抗模型用自己的经验覆盖指令               │
│  格式：否定词 + 解释原因（有理由的指令遵循度更高）                   │
├──────────────────────────────────────────────────────────────────┤
│  第四层：输出约束（Output Constraints）                           │
│  告诉模型「输出必须符合什么格式」                                   │
│  格式：引用 templates/ 目录中的模板文件                            │
└──────────────────────────────────────────────────────────────────┘
```

### 3.6 SKILL.md 编写规范（纯指令，无元数据）

#### 3.6.1 核心原则：SKILL.md 只含执行指令

SKILL.md 是模型在 `skill_view` 时读取的文件，它的唯一职责是告诉模型「怎么执行这个技能」。所有与分发、分类、权限相关的元数据（category、tags、description、visibility 等）由服务端管理，**不应出现在 SKILL.md 中**。

这样做的好处：
- **同一份技能包可被不同服务端赋予不同的分类和标签**
- **技能提供者无需关心部署环境的分类体系**
- **SKILL.md 保持精简，降低模型的认知负担**

#### 3.6.2 推荐的 SKILL.md 格式（纯 Markdown）

```markdown
# Prompt Writer

## 概述

此技能提供专业级别的 AI 提示词编写与优化能力。它不是通用的"帮我写个 prompt"，
而是一套包含框架选择、迭代优化、质量评估的完整工作流。

## 触发条件

当用户的需求涉及以下场景时，激活此技能：
- 编写新的提示词
- 优化或重构现有提示词
- 设计系统提示词（System Prompt）
- 提示词效果评估与调优

## 执行步骤（必须严格按序执行）

### Step 1: 需求分析
使用以下模板分析用户需求：
> 目标：[用户想达到什么效果]
> 受众：[模型类型：GPT-4 / Claude / 通用]
> 上下文：[使用场景]
> 约束：[长度、格式、特殊要求]

### Step 2: 框架选择
根据需求分析结果，选择合适的提示词框架：
- **CREATE** 框架（创意类任务）→ 参考 `references/create-framework.md`
- **CRISPE** 框架（精确控制类任务）→ 参考 `references/crispe-framework.md`
- **RTF** 框架（角色扮演类任务）→ 参考 `references/rtf-framework.md`

### Step 3: 起草提示词
按选定框架的结构编写提示词初稿。

### Step 4: 自检清单
使用 `templates/checklist.md` 中的检查清单逐项验证。

## 输出格式

最终输出使用 `templates/output-template.md` 中定义的格式。

## 已知陷阱

- 不要在提示词中使用 "you are" 开头——这会限制模型的灵活性
- 避免过度约束：每增加一个约束，模型的创造力下降约 15%
- Chain-of-Thought 提示词应在最后一步而非第一步要求推理
```

> **注意**：没有 YAML frontmatter。技能的 name、category、tags、description 等元数据全部在服务端维护。但系统同时兼容带 frontmatter 的 SKILL.md（导入时自动提取并转为服务端元数据）。

#### 3.6.3 manifest.json 仅含包结构信息

```json
{
  "name": "prompt-writer",
  "version": "1.0.0",
  "entry": "SKILL.md",
  "files": [
    "SKILL.md",
    "references/create-framework.md",
    "references/crispe-framework.md",
    "references/rtf-framework.md",
    "templates/checklist.md",
    "templates/output-template.md"
  ]
}
```

### 3.7 激活引导与安全扫描

#### 3.7.1 skill_view 激活引导注入

```typescript
async viewSkillEntry(skillSlug: string): Promise<string> {
  const content = await this.readEntryFile(skillSlug);
  const files = await this.listSkillFiles(skillSlug);

  return [
    `[SYSTEM: 用户正在使用 "${skillSlug}" 技能。以下为技能完整指令，请严格遵循执行。]`,
    ``,
    content,
    ``,
    `[可用辅助文件: ${files}]`,
    `[提示: 如需读取辅助文件，使用 skill_file("${skillSlug}", ["文件路径1", "文件路径2"]) 批量加载]`,
  ].join("\n");
}
```

#### 3.7.2 安全扫描

技能包在上传和加载时均执行 prompt injection 模式扫描：

```typescript
const INJECTION_PATTERNS = [
  /ignore\s+(previous|above|all)\s+(instructions?|prompts?)/i,
  /forget\s+(everything|all|previous)/i,
  /you\s+are\s+now\s+(a|an|free)/i,
  /system\s*:\s*$/m,
];

export function scanForInjection(content: string): { safe: boolean; issues: string[] } {
  const issues: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      issues.push(`检测到可疑模式: ${pattern.source}`);
    }
  }
  return { safe: issues.length === 0, issues };
}
```

### 3.8 遵循度验证指标

| 指标 | 定义 | 目标值 |
|------|------|--------|
| 技能扫描率 | 模型回复前是否扫描了技能索引 | > 95% |
| 技能加载率 | 发现相关技能后是否调用 skill_view | > 90% |
| 指令遵循率 | 加载后是否按步骤执行 | > 85% |
| 批量加载使用率 | 使用 skill_file 批量路径 vs 多次单路径调用 | > 70% |

---

## 4. 部署架构：单体模式与网关-服务拆分模式

系统支持两种部署模式，以满足不同的运维和使用场景。

### 4.1 模式 A：单体部署

整个系统作为单个进程运行，技能文件存储在本地或云端存储中，MCP 协议层直接操作本地存储和数据库。

```
┌──────────────────────────────────────────────────┐
│               MCP Client (宿主环境)                │
└──────────────────────┬───────────────────────────┘
                       │ stdio / SSE / HTTP
                       ▼
┌──────────────────────────────────────────────────┐
│              单体 MCP Server 进程                  │
│                                                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │ MCP 协议层  │  │ 遵循度引擎  │  │ 权限过滤器  │ │
│  │ (3 传输)   │  │ (提示词构建) │  │            │ │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘ │
│        └───────────────┼───────────────┘         │
│                        ▼                          │
│              ┌────────────────────┐              │
│              │   Skill Service    │              │
│              └─────────┬──────────┘              │
│         ┌──────────────┼──────────────┐          │
│         ▼              ▼              ▼          │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│   │ Storage  │  │  Cache   │  │   DB     │   │
│   │ (本地/   │  │ (内存+   │  │ (SQLite) │   │
│   │  OSS)    │  │  文件)   │  │          │   │
│   └──────────┘  └──────────┘  └──────────┘   │
│                                                    │
│  ┌────────────────────────────────────────────┐  │
│  │ Admin API + CLI (技能导入/管理)            │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

**适用场景**：
- 个人开发者本地使用
- 小团队内网部署
- 技能不需要跨实例共享的场景
- 快速原型和开发调试

### 4.2 模式 B：网关-服务拆分

将系统拆分为两个独立服务，各自承担不同职责：

```
┌──────────────────────────────────────────────────┐
│               MCP Client (宿主环境)                │
└──────────────────────┬───────────────────────────┘
                       │ stdio (本地进程)
                       ▼
┌──────────────────────────────────────────────────┐
│          MCP Gateway（网关，靠近模型侧）            │
│                                                    │
│  职责：                                             │
│  ─ MCP 协议处理（stdio 传输）                       │
│  ─ 遵循度引擎（构建 instructions、Tool Description）│
│  ─ 鉴权信息携带（将 token/user_id 转发给云端）       │
│  ─ 本地缓存（已授权技能索引、已加载的技能内容）      │
│  ─ Tool 路由：skill_list/skill_view/skill_file      │
│                                                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │ MCP 协议层  │  │ 遵循度引擎  │  │ 本地缓存   │ │
│  │ (stdio)    │  │ (提示词)   │  │ (内存+文件)│ │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘ │
│        └───────────────┼───────────────┘         │
│                        ▼                          │
│              ┌────────────────────┐              │
│              │  Gateway Service   │              │
│              │ (鉴权 + 缓存 +    │              │
│              │  遵循度注入 +      │              │
│              │  请求转发)         │              │
│              └─────────┬──────────┘              │
└────────────────────────┼────────────────────────┘
                         │ HTTPS (REST API)
                         │ 携带 Authorization: Bearer <token>
                         ▼
┌──────────────────────────────────────────────────┐
│       Cloud Skill Service（云端技能服务）           │
│                                                    │
│  职责：                                             │
│  ─ 技能元数据管理（CRUD、分类、标签）               │
│  ─ 权限管理与按权限输出数据                          │
│  ─ 技能文件存储与分发                               │
│  ─ 技能包上传与导入                                 │
│                                                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │ REST API   │  │ 权限管理   │  │ 技能管理   │ │
│  │ (HTTP)     │  │ (RBAC)     │  │ (CRUD)     │ │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘ │
│        └───────────────┼───────────────┘         │
│                        ▼                          │
│              ┌────────────────────┐              │
│              │  Cloud Service     │              │
│              └─────────┬──────────┘              │
│         ┌──────────────┼──────────────┐          │
│         ▼              ▼              ▼          │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│   │ Storage  │  │  Cache   │  │   DB     │   │
│   │ (OSS/    │  │ (Redis/  │  │ (PG/     │   │
│   │  S3)     │  │  内存)   │  │  MySQL)  │   │
│   └──────────┘  └──────────┘  └──────────┘   │
│                                                    │
│  ┌────────────────────────────────────────────┐  │
│  │ Admin Dashboard (技能管理后台)              │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

#### 4.2.1 两个服务的职责划分

| 职责 | MCP Gateway | Cloud Skill Service |
|------|-------------|-------------------|
| MCP 协议处理 | 负责（stdio/SSE/HTTP） | 不涉及 |
| 遵循度引擎 | 负责（instructions 构建、激活引导注入） | 不涉及 |
| Tool Description 生成 | 负责 | 不涉及 |
| 用户鉴权 | 携带鉴权信息（转发 token） | 验证鉴权信息 |
| 权限过滤 | 按云端返回的权限列表过滤 | 按权限策略输出数据 |
| 技能元数据查询 | 缓存 + 转发 | 主数据源 |
| 技能文件读取 | 缓存 + 转发 | 主数据源 |
| 技能包上传/导入 | CLI 导入 → 转发到云端 | 接收、校验、存储 |
| 技能分类/标签管理 | 使用（按云端数据生成索引） | 维护（CRUD） |
| 技能包物理存储 | 不存储 | 存储（OSS/本地） |
| 用户管理 | 不涉及 | 管理 |

#### 4.2.2 Gateway 与 Cloud Service 之间的 API

```typescript
// Cloud Skill Service 对外暴露的 REST API
interface CloudSkillServiceAPI {
  // 认证
  POST   /api/auth/token              // 获取访问令牌

  // 技能列表（按权限过滤）
  GET    /api/skills                   // 获取已授权技能列表
  GET    /api/skills/:slug             // 获取技能详情

  // 技能文件读取
  GET    /api/skills/:slug/entry       // 读取技能入口文件 (SKILL.md)
  POST   /api/skills/:slug/files       // 批量读取技能文件

  // 技能管理
  POST   /api/admin/skills             // 上传技能包
  PUT    /api/admin/skills/:slug       // 更新技能元数据（分类、标签、描述）
  DELETE /api/admin/skills/:slug       // 删除技能
  GET    /api/admin/skills/:slug/files // 获取技能文件树
}
```

### 4.3 两种模式对比与选择指南

| 维度 | 模式 A：单体 | 模式 B：网关-服务拆分 |
|------|------------|---------------------|
| 部署复杂度 | 低（一个进程） | 高（两个服务 + 网络） |
| 技能管理 | 本地管理（CLI/API） | 云端统一管理（Dashboard + API） |
| 多用户支持 | 无（单用户） | 有（用户 + 权限体系） |
| 技能共享 | 需手动同步 | 天然共享（集中存储） |
| 适合团队规模 | 个人 / 小团队 | 企业 / 多团队 |
| 扩展性 | 垂直扩展 | 水平扩展 |
| 网络依赖 | 无 | Gateway ↔ Cloud 需要 HTTPS |
| 适用场景 | 本地开发、个人使用 | 企业级部署、技能市场化 |

**两种模式都必须实现，通过配置切换**。

### 4.4 统一接口抽象

为支持两种模式的无缝切换，定义统一的 `ISkillProvider` 接口，Gateway/Service 内部的 SkillService 依赖此接口，而非直接依赖存储层：

```typescript
/**
 * 统一技能提供者接口
 * 单体模式：LocalSkillProvider（直接操作本地存储和数据库）
 * 拆分模式：RemoteSkillProvider（通过 HTTPS 调用云端服务）
 */
export interface ISkillProvider {
  // 技能列表
  listSkills(options?: { category?: string; tags?: string[] }): Promise<SkillMeta[]>;

  // 技能入口文件
  getSkillEntry(skillSlug: string): Promise<string>;

  // 批量读取辅助文件
  getSkillFiles(skillSlug: string, filePaths: string[]): Promise<SkillFileContent[]>;

  // 技能文件树
  getSkillFileTree(skillSlug: string): Promise<FileInfo[]>;

  // 技能存在性检查
  skillExists(skillSlug: string): Promise<boolean>;
}

// 单体模式实现
export class LocalSkillProvider implements ISkillProvider {
  constructor(
    private storage: IStorageProvider,
    private skillRepo: SkillRepository,
    // ...
  ) {}
  // 直接操作本地存储和数据库
}

// 拆分模式实现
export class RemoteSkillProvider implements ISkillProvider {
  constructor(
    private cloudServiceUrl: string,
    private authToken: string,
    // ...
  ) {}
  // 通过 HTTP 调用云端服务
  async getSkillEntry(skillSlug: string): Promise<string> {
    const resp = await fetch(`${this.cloudServiceUrl}/api/skills/${skillSlug}/entry`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    });
    return resp.text();
  }
}
```

---

## 5. 传输层设计：stdio / SSE / HTTP

### 5.1 三种传输协议概览

| 传输方式 | 适用场景 | 连接方向 | 双向通信 | 身份传递 |
|---------|---------|---------|---------|---------|
| **stdio** | 本地 CLI、IDE 集成 | 子进程管道 | 半双工（in/out） | 环境变量 |
| **SSE** | Web IDE、浏览器 | 客户端发起，服务端推送 | 半双工（SSE + POST） | HTTP Header |
| **Streamable HTTP** | 远程 API、服务间通信 | 双向 HTTP | 全双工 | HTTP Header / Bearer Token |

### 5.2 stdio 传输

MCP Client 将 Server 作为子进程启动，通过标准输入输出通信。

```typescript
// src/mcp/transport/stdio.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export function createStdioTransport() {
  return new StdioServerTransport();
}
```

**CLI 集成方式**：
```json
{
  "mcpServers": {
    "skill-mcp": {
      "command": "node",
      "args": ["dist/index.js", "--transport", "stdio"],
      "env": { "SKILL_MCP_CONFIG": "/path/to/config.json" }
    }
  }
}
```

### 5.3 SSE 传输

基于 Server-Sent Events 的传输方式，适合 Web 端集成。客户端通过 GET 请求建立 SSE 连接接收服务端消息，通过 POST 请求发送客户端消息。

```typescript
// src/mcp/transport/sse.ts
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

export function createSSETransport(server: FastifyInstance) {
  // GET /mcp/sse — 建立 SSE 连接
  server.get("/mcp/sse", async (request, reply) => {
    const transport = new SSEServerTransport("/mcp/messages", reply.raw);
    await server.mcpServer.connect(transport);
  });

  // POST /mcp/messages — 发送客户端消息
  server.post("/mcp/messages", async (request, reply) => {
    // SSEServerTransport 自动处理
  });
}
```

**Web 端集成方式**：
```json
{
  "mcpServers": {
    "skill-mcp": {
      "url": "https://mcp.example.com/mcp/sse",
      "headers": { "Authorization": "Bearer sk-xxx" }
    }
  }
}
```

### 5.4 Streamable HTTP 传输

MCP 最新引入的 HTTP 传输方式，支持在单个 HTTP 连接上进行双向流式通信。

```typescript
// src/mcp/transport/http.ts
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export function createHTTPTransport(server: FastifyInstance) {
  // POST /mcp — Streamable HTTP 端点
  server.post("/mcp", async (request, reply) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.mcpServer.connect(transport);
    await transport.handleRequest(request.raw, reply.raw);
  });

  // GET /mcp — 用于 SSE fallback
  server.get("/mcp", async (request, reply) => {
    // Session resume via SSE
  });

  // DELETE /mcp — 关闭会话
  server.delete("/mcp", async (request, reply) => {
    // Session termination
  });
}
```

**远程 API 集成方式**：
```json
{
  "mcpServers": {
    "skill-mcp": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer sk-xxx" }
    }
  }
}
```

### 5.5 传输层统一接口

```typescript
// src/mcp/transport/index.ts
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export type TransportType = "stdio" | "sse" | "http";

export function createTransport(
  type: TransportType,
  options: TransportOptions
): Transport {
  switch (type) {
    case "stdio": return createStdioTransport();
    case "sse":   return createSSETransport(options.fastify);
    case "http":  return createHTTPTransport(options.fastify);
  }
}
```

**启动参数**：
```bash
# stdio 模式（默认，用于 CLI 和 IDE 集成）
node dist/index.js --transport stdio

# SSE 模式（用于 Web IDE）
node dist/index.js --transport sse --port 3000

# HTTP 模式（用于远程 API）
node dist/index.js --transport http --port 3000
```

---

## 6. 系统架构设计

### 6.1 架构总览（含传输层和部署模式）

```
┌─────────────────────────────────────────────────────────────────────┐
│                     MCP Client (宿主环境)                            │
│             (Claude Desktop / Cursor / Web IDE / CLI)                │
└──────┬──────────────────┬──────────────────┬────────────────────────┘
       │ stdio            │ SSE              │ HTTP
       ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     MCP Server / Gateway                             │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    Transport Layer                              │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                    │ │
│  │  │  stdio   │  │   SSE    │  │  HTTP    │                    │ │
│  │  └──────────┘  └──────────┘  └──────────┘                    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    MCP Protocol Layer                           │ │
│  │                                                                │ │
│  │  ┌──────────────────────┐  ┌──────────────────────────────┐   │ │
│  │  │   instructions 注入   │  │    Tool Registry             │   │ │
│  │  │  (系统提示词 + 技能索引)│  │                              │   │ │
│  │  └──────────────────────┘  │  ┌────────────────────────┐  │   │ │
│  │                            │  │ skill_list             │  │   │ │
│  │                            │  ├────────────────────────┤  │   │ │
│  │                            │  │ skill_view             │  │   │ │
│  │                            │  ├────────────────────────┤  │   │ │
│  │                            │  │ skill_file             │  │   │ │
│  │                            │  │ (支持批量路径)          │  │   │ │
│  │                            │  └────────────────────────┘  │   │ │
│  │                            └──────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                     Service Layer                               │ │
│  │                                                                │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │ │
│  │  │  Skill       │  │  Permission  │  │  Security Scanner  │  │ │
│  │  │  Service     │  │  Filter      │  │  (injection scan)  │  │ │
│  │  └──────┬───────┘  └──────────────┘  └────────────────────┘  │ │
│  └─────────┼─────────────────────────────────────────────────────┘ │
│            │                                                         │
│  ┌─────────┼─────────────────────────────────────────────────────┐ │
│  │         │          ISkillProvider (统一接口)                    │ │
│  │         │                                                     │ │
│  │  ┌──────▼──────────────┐  ┌─────────────────────────────────┐│ │
│  │  │ LocalSkillProvider  │  │ RemoteSkillProvider              ││ │
│  │  │ (单体模式)          │  │ (拆分模式，转发到云端服务)       ││ │
│  │  │ ↓ Storage + DB     │  │ ↓ HTTPS → Cloud Skill Service   ││ │
│  │  └─────────────────────┘  └─────────────────────────────────┘│ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Admin API (HTTP)  │  CLI Commands  │  Cache Layer             │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7. 元数据与内容职责分离

### 7.1 职责划分原则

系统中的「技能信息」分为两类，各自由不同角色管理：

| 信息类型 | 管理者 | 存储位置 | 用途 |
|---------|--------|---------|------|
| **服务端元数据** | 服务管理员 / Dashboard | 数据库 | 技能索引展示、分类分组、权限控制、搜索 |
| **技能包内容** | 技能提供者 | 技能包文件 | 模型加载后执行的指令、参考、模板 |

```
技能信息全景图:

┌──────────────────────────────────────┐
│         服务端元数据 (DB)              │
│  ─────────────────────────            │
│  id: "uuid-xxx"                      │  ← 系统内部 ID
│  slug: "prompt-writer"              │  ← 唯一标识符（用于 API 调用）
│  name: "prompt-writer"              │  ← 技能名称（可重复）
│  display_name: "提示词编写专家"      │  ← 管理员自定义展示名（可选）
│  description: "专业提示词编写..."    │  ← 管理员为索引优化的描述
│  version: "1.0.0"                   │  ← 三位语义化版本号
│  category: "writing"                │  ← 分类（可选属性，用于 API 筛选）
│  tags: ["prompt", "creative"]       │  ← 标签（可选属性，用于 API 筛选）
│  attributes: {"language": "zh-CN",  │  ← 自定义属性键值对（灵活扩展）
│    "complexity": "advanced"}        │
│  storage_path: "skills/prompt-      │  ← 物理存储目录路径
│    writer/"                          │
│  content_hash: "sha256:abc123..."   │  ← 所有文件的内容哈希（版本变更检测）
│  status: "published"                │
│  visibility: "public"               │
│  assigned_groups: ["team-a"]        │  ← 权限分组（拆分模式）
│  created_at / updated_at            │
└──────────────────────────────────────┘
                    │
                    │ slug 匹配
                    ▼
┌──────────────────────────────────────┐
│       技能包内容 (文件系统)            │
│  ─────────────────────────            │
│  manifest.json: (name, version,      │  ← 包结构元信息
│    entry, files)                      │
│  SKILL.md: (纯执行指令)              │  ← 模型读取的唯一入口
│  references/: (参考文档)             │
│  templates/: (输出模板)              │
│  scripts/: (辅助脚本)                │
│  resources/: (图片、视频)            │
└──────────────────────────────────────┘
```

### 7.2 服务端元数据（Server-side Metadata）

#### 7.2.1 skills 表设计

```sql
CREATE TABLE skills (
  id              TEXT PRIMARY KEY,           -- UUID
  slug            TEXT NOT NULL UNIQUE,       -- 唯一标识符（kebab-case，用于 API 调用和索引展示）
  name            TEXT NOT NULL,              -- 技能名称（可重复，匹配 manifest.name）
  display_name    TEXT,                       -- 管理员自定义展示名（可选）
  description     TEXT NOT NULL DEFAULT '',   -- 索引描述（可不同于 SKILL.md 内容）
  version         TEXT NOT NULL DEFAULT '1.0.0',  -- 三位语义化版本号
  category        TEXT DEFAULT NULL,          -- 分类（可选，不再作为核心字段）
  tags            TEXT,                       -- JSON 数组：标签（可选）
  attributes      TEXT,                       -- JSON 对象：自定义属性键值对（灵活扩展）
  status          TEXT NOT NULL DEFAULT 'draft',   -- draft/published/deprecated/archived
  visibility      TEXT NOT NULL DEFAULT 'public',
  entry_file      TEXT DEFAULT 'SKILL.md',
  storage_path    TEXT NOT NULL,              -- 技能文件物理存储目录路径
  content_hash    TEXT,                       -- 所有文件内容的 SHA-256 哈希（用于版本变更检测）
  conditions      TEXT,                       -- JSON：条件激活规则
  assigned_groups TEXT,                       -- JSON：权限分组（拆分模式）
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- skill_names 允许重复，通过 slug 唯一标识
CREATE UNIQUE INDEX idx_skills_slug ON skills(slug);
CREATE INDEX idx_skills_name ON skills(name);
CREATE INDEX idx_skills_status ON skills(status);
CREATE INDEX idx_skills_visibility ON skills(visibility);
```

**关键点**：
- `slug` 是技能的唯一标识符（UNIQUE），用于 API 调用和索引展示
- `name` 允许重复（不再有 UNIQUE 约束），匹配 manifest.json 中的 `name`
- `display_name` 和 `description` 由管理员在服务端自定义，用于 `<available_skills>` 索引展示
- `category` 和 `tags` 为可选属性，用于 API 级别的筛选，不用于索引分组
- `attributes` 是灵活的 JSON 键值对，支持自定义扩展属性
- `storage_path` 记录技能文件的物理存储目录路径
- `content_hash` 为所有文件内容的 SHA-256 哈希，用于检测内容变更和版本管理
- `assigned_groups` 用于权限控制（拆分模式下由云端管理）

#### 7.2.2 属性管理（分类、标签、自定义属性）

技能的属性（category、tags、attributes）完全由服务端管理。管理员在导入技能时或后续编辑时指定：

- **category**：可选的分类属性，用于 API 级别的筛选（如 `GET /api/skills?category=writing`），**不用于索引分组**
- **tags**：可选的标签属性，支持多标签筛选（如 `GET /api/skills?tags=prompt`）
- **attributes**：灵活的 JSON 键值对，支持自定义扩展属性（如 `{"language": "zh-CN", "complexity": "advanced"}`）

```
管理员操作:

1. 导入技能包时指定属性:
   $ skill-mcp import ./prompt-writer --category writing --tags "prompt,creative"

2. 后续修改属性:
   PUT /api/skills/prompt-writer
   { "category": "writing", "tags": ["prompt", "creative", "advanced"],
     "attributes": {"language": "zh-CN", "complexity": "advanced"} }

3. API 筛选（不用于索引分组）:
   GET /api/skills?category=writing&tags=prompt&attributes.language=zh-CN

4. 系统提示词中的索引为平铺列表（不分组）:
   <available_skills>
     - prompt-writer: 专业提示词编写与优化
     - code-review: 代码审查技能
   </available_skills>
```

### 7.3 技能包内容（Skill Package Content）

技能包内容只关心「怎么执行」，不关心「怎么分类和展示」。

```
prompt-writer/
├── SKILL.md              # 纯指令内容（不含元数据）
├── manifest.json         # 包结构信息（name, version, entry, files）
├── references/           # 参考文档
│   ├── create-framework.md
│   └── crispe-framework.md
├── templates/            # 输出模板
│   ├── output-template.md
│   └── checklist.md
├── scripts/              # 辅助脚本
└── resources/            # 资源文件
    ├── images/
    └── videos/
```

### 7.4 元数据管理 API

```typescript
// 更新技能元数据（不影响技能包内容）
PUT /api/skills/:slug
Content-Type: application/json

{
  "display_name": "提示词编写专家",
  "description": "专业级 AI 提示词编写与优化，支持 CREATE/CRISPE/RTF 三大框架",
  "category": "writing",
  "tags": ["prompt-engineering", "creative", "advanced"],
  "attributes": {"language": "zh-CN", "complexity": "advanced"},
  "visibility": "public",
  "assigned_groups": ["all-staff", "content-team"]
}
```

---

## 8. 完整运行流程图与时序图

### 8.1 系统启动与初始化流程

```
┌─────────┐
│  启动    │
└────┬────┘
     │
     ▼
┌─────────────────────┐
│ 解析启动参数          │  --transport stdio|sse|http
│ --port / --config    │
└────┬────────────────┘
     │
     ▼
┌─────────────────────┐
│ 加载配置              │  .env + zod 校验
│ 判断部署模式          │  standalone | gateway
└────┬────────────────┘
     │
     ├──────────────┐
     │              │
  standalone      gateway
     │              │
     ▼              ▼
┌──────────┐  ┌──────────────────┐
│ 初始化    │  │ 初始化            │
│ 本地      │  │ RemoteSkill      │
│ DB+存储+  │  │ Provider         │
│ 缓存      │  │ (连接云端服务)    │
└────┬─────┘  └────────┬─────────┘
     │               │
     └───────┬───────┘
             │
             ▼
┌─────────────────────┐
│ 创建 SkillProvider   │  LocalSkillProvider 或 RemoteSkillProvider
└────┬────────────────┘
     │
     ▼
┌─────────────────────┐
│ 预热技能索引缓存      │  从 SkillProvider 加载已授权技能列表
└────┬────────────────┘
     │
     ▼
┌─────────────────────┐
│ 构建系统提示词        │  生成平铺的 <available_skills> 索引（slug + description，不分组）
└────┬────────────────┘
     │
     ▼
┌─────────────────────┐
│ 注册 MCP Tools       │  skill_list / skill_view / skill_file
└────┬────────────────┘
     │
     ├──────────────┬──────────────┐
     ▼              ▼              ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ stdio    │ │ SSE      │ │ HTTP     │
│ 传输     │ │ 传输     │ │ 传输     │
└──────────┘ └──────────┘ └──────────┘
```

### 8.2 技能发现与加载时序图

```
 用户      MCP Client    MCP Server/Gateway    SkillProvider     Cache
  │             │                  │                  │             │
  │ "帮我优化   │                  │                  │             │
  │  提示词"   │                  │                  │             │
  │───────────>│                  │                  │             │
  │             │                  │                  │             │
  │             │ ① 扫描系统提示    │                  │             │
  │             │ 匹配到            │                  │             │
  │             │ prompt-writer    │                  │             │
  │             │                  │                  │             │
  │             │ tools/call       │                  │             │
  │             │ skill_list ─────>│                  │             │
  │             │                  │── cache.get ────>│             │
  │             │                  │<── cache hit ────│             │
  │             │<── 紧凑索引 ─────│                  │             │
  │             │                  │                  │             │
  │             │ ② 调用           │                  │             │
  │             │ skill_view ─────>│                  │             │
  │             │                  │── cache.get ────>│             │
  │             │                  │<── miss ────────│             │
  │             │                  │── provider.get ─>│             │
  │             │                  │   Entry()        │             │
  │             │                  │                  │             │
  │             │                  │<── SKILL.md ─────│             │
  │             │                  │── security.scan()│             │
  │             │                  │── cache.set ────>│             │
  │             │                  │                  │             │
  │             │<── [激活引导]     │                  │             │
  │             │     + SKILL.md   │                  │             │
  │             │     + 可用文件    │                  │             │
  │             │                  │                  │             │
  │             │ ③ 按 SKILL.md    │                  │             │
  │             │ 执行，需要加载    │                  │             │
  │             │ CRISPE 框架 +    │                  │             │
  │             │ 自检清单          │                  │             │
  │             │                  │                  │             │
  │             │ tools/call       │                  │             │
  │             │ skill_file ─────>│                  │             │
  │             │ {skill_slug,     │                  │             │
  │             │  file_paths:     │                  │             │
  │             │  ["references/   │                  │             │
  │             │   crispe-        │                  │             │
  │             │   framework.md", │                  │             │
  │             │   "templates/    │                  │             │
  │             │   checklist.md"] │                  │             │
  │             │ }                │                  │             │
  │             │                  │── cache.get ────>│             │
  │             │                  │<── miss ────────│             │
  │             │                  │── provider.get ─>│             │
  │             │                  │   Files(         │             │
  │             │                  │     [paths])    │             │
  │             │                  │  (并发读取)      │             │
  │             │                  │<── [file1, ─────│             │
  │             │                  │     file2]       │             │
  │             │                  │── cache.set ────>│             │
  │             │                  │                  │             │
  │             │<── 批量文件内容 ──│                  │             │
  │             │                  │                  │             │
  │             │ ④ 按框架 + 清单   │                  │             │
  │             │ 执行任务          │                  │             │
  │<────────────│                  │                  │             │
  │ 优化后提示词 │                  │                  │             │
```

### 8.3 技能执行完整流程图

```
用户请求
    │
    ▼
┌─────────────────────┐
│ 系统提示中的          │
│ <available_skills>   │
│ 平铺展示（slug +     │
│ description）        │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ 模型扫描技能索引      │
│ 逐条匹配用户意图      │
└────────┬────────────┘
         │
    ┌────┴────┐
 有匹配   无匹配
    │         │
    ▼         ▼
skill_view  直接回复
    │
    ▼
┌─────────────────────┐
│ 解析 SKILL.md：       │
│ 触发条件→确认匹配     │
│ 执行步骤→建立计划     │
│ 文件引用→确定加载列表  │
└────────┬────────────┘
         │
         ▼
┌─────────────────────────────┐
│ 需要加载辅助文件？           │
│                              │
│ skill_file(slug, [path1,    │
│   path2, path3])            │
│ ← 一次批量加载所有需要的文件  │
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────┐
│ 严格按 Step 执行      │
│ 融入所有辅助文件内容   │
│ (循环直到所有步骤完成)│
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ 输出最终结果          │
│ (符合技能输出格式)    │
└─────────────────────┘
```

### 8.4 技能包导入流程（CLI + API）

```
管理员/CI
    │
    ├──────────────────────────────────┐
    │                                  │
 CLI 方式                            API 方式
    │                                  │
    ▼                                  ▼
┌─────────────┐              ┌─────────────────┐
│ skill-mcp   │              │ POST /api/skills │
│ import      │              │ multipart/form   │
│             │              │ file: *.zip      │
│ 来源:       │              └────────┬────────┘
│ - 本地目录   │                       │
│ - Git 仓库   │                       │
└──────┬──────┘                       │
       │                               │
       ▼                               │
┌──────────────────┐                   │
│ 1. 准备技能包     │◄──────────────────┘
│ 本地: 直接读取     │
│ Git: clone 到临时  │
│ 目录后读取         │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ 2. 解析 manifest  │
│ 校验 name,       │
│ version, entry   │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ 2.5 检查重名      │
│ 用 name 搜索 DB  │
│ 已有同名技能？     │
└────┬───────────┘
     │
     ├── 无重名 ──→ slug = name
     │               storage_path = skills/{slug}/
     │
     └── 有重名 ──→ 列出所有同名技能
                    用户必须指定 --id 或 --slug
                    未指定则报错拒绝导入
                    
                    指定后:
                    slug = 已有技能的 slug（覆盖更新）
                    继续到步骤 3
       │
       ▼
┌──────────────────┐
│ 3. 解析 SKILL.md  │
│ (如果含 front-    │
│  matter，提取元   │
│  数据作为默认值)   │
│ 安全扫描通过？     │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ 3.5 计算内容哈希  │
│ 遍历所有文件，    │
│ 计算 SHA-256     │
│ 与 DB 中已有      │
│ content_hash 对比 │
│                    │
│ 内容未变？         │
│ ── 是 → 拒绝导入  │
│       "内容未变，  │
│        无需更新"   │
│ ── 否 → 继续      │
└────┬───────────┘
       │
       ▼
┌──────────────────────────────────┐
│ 4. 写入存储层                     │
│ storage.put(                     │
│   "{storage_path}{path}", buffer)│
│ 遍历所有文件                      │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ 5. 写入/更新 DB 元数据             │
│ - slug, name (from manifest)      │
│ - version (语义化版本号，自动升级)  │
│ - category (from --category 参数) │
│ - tags (from --tags 参数)         │
│ - description (from --desc 参数   │
│   或 SKILL.md 第一段)             │
│ - storage_path, content_hash      │
│ - status = 'published'            │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ 6. 清除缓存                       │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ 7. 返回结果                       │
│ { slug, name, version,           │
│   fileCount, category, tags }    │
└──────────────────────────────────┘
```

### 8.5 网关-服务拆分模式下的完整时序

```
 用户       MCP Client   Gateway(GW)   Cloud Service(CS)   DB/OSS
  │             │            │              │                │
  │ "帮我写     │            │              │                │
  │  技术文档"  │            │              │                │
  │───────────>│            │              │                │
  │             │            │              │                │
  │             │ (GW 系统提示: │              │                │
  │             │  已预加载的   │              │                │
  │             │  技能索引缓存) │              │                │
  │             │            │              │                │
  │             │ skill_list │              │                │
  │             │ ──────────>│              │                │
  │             │            │── cache ─────>│                │
  │             │            │<── hit ───────│                │
  │             │<── 索引 ────│              │                │
  │             │            │              │                │
  │             │ skill_view │              │                │
  │             │ (tech-doc) │              │                │
  │             │ ──────────>│              │                │
  │             │            │── cache ─────>│                │
  │             │            │<── miss ──────│                │
  │             │            │              │                │
  │             │            │── HTTPS GET ──────────────────>│
  │             │            │  /api/skills/ │                │
  │             │            │  tech-doc/    │                │
  │             │            │  entry        │                │
  │             │            │  Auth: Bearer │                │
  │             │            │              │                │
  │             │            │              │── 权限检查 ────>│
  │             │            │              │── 查询 DB ──────>│
  │             │            │              │<── skill data ───│
  │             │            │              │── 读取 OSS ────>│
  │             │            │              │<── file ────────│
  │             │            │              │                │
  │             │            │<── SKILL.md ───────────────────│
  │             │            │── cache.set ─>│                │
  │             │            │── 注入激活   │                │
  │             │            │   引导        │                │
  │             │<── [引导]+  │              │                │
  │             │  SKILL.md ─│              │                │
  │             │            │              │                │
  │             │ skill_file │              │                │
  │             │ ──────────>│              │                │
  │             │ [paths: ["  │              │                │
  │             │  refs/api-  │              │                │
  │             │  spec.md", │              │                │
  │             │  tmpl/      │              │                │
  │             │  doc.md"]   │              │                │
  │             │            │── HTTPS POST ─────────────────>│
  │             │            │  /api/skills/ │                │
  │             │            │  tech-doc/    │                │
  │             │            │  files        │                │
  │             │            │  body: {paths}│                │
  │             │            │              │── 批量读取 ────>│
  │             │            │              │<── [file1,2] ───│
  │             │            │<── [file1,2] ──────────────────│
  │             │            │── cache.set ─>│                │
  │             │<── 批量内容─│              │                │
  │             │            │              │                │
  │             │ 按技能指令  │              │                │
  │             │ 执行任务    │              │                │
  │<────────────│            │              │                │
```

---

## 9. 项目结构

```
skill-mcp-server/
├── src/
│   ├── index.ts                          # 应用入口（解析 --transport 参数）
│   ├── app.ts                            # Fastify 实例（SSE/HTTP 模式）
│   │
│   ├── mcp/                              # MCP 协议层
│   │   ├── server.ts                     # MCP Server 初始化
│   │   ├── resources.ts                  # MCP Resources 注册
│   │   ├── transport/
│   │   │   ├── stdio.ts
│   │   │   ├── sse.ts
│   │   │   ├── http.ts
│   │   │   └── index.ts                  # 传输工厂
│   │   └── tools/
│   │       ├── registry.ts
│   │       ├── skill-list.ts
│   │       ├── skill-view.ts
│   │       └── skill-file.ts             # 支持批量路径
│   │
│   ├── prompt/
│   │   ├── system-prompt.ts              # 系统提示词构建器
│   │   └── descriptions.ts               # Tool Description 常量
│   │
│   ├── provider/                         # ISkillProvider 统一接口
│   │   ├── interface.ts                  # ISkillProvider 接口定义
│   │   ├── local.provider.ts             # 单体模式实现
│   │   └── remote.provider.ts            # 拆分模式实现（HTTPS）
│   │
│   ├── services/
│   │   ├── skill.service.ts              # 技能核心逻辑
│   │   └── access-log.service.ts
│   │
│   ├── permission/
│   │   ├── filter.interface.ts
│   │   ├── noop-filter.ts               # MVP
│   │   └── subscription-filter.ts        # 后续
│   │
│   ├── import/                           # 技能导入模块
│   │   ├── importer.ts                   # 导入核心逻辑
│   │   ├── local-source.ts               # 本地目录导入
│   │   ├── git-source.ts                 # Git 仓库导入
│   │   └── validator.ts                  # 导入校验（manifest + 安全扫描）
│   │
│   ├── storage/
│   │   ├── provider.interface.ts
│   │   ├── local-fs.provider.ts
│   │   └── aliyun-oss.provider.ts        # 预留
│   │
│   ├── cache/
│   │   ├── provider.interface.ts
│   │   ├── memory-lru.provider.ts
│   │   ├── file.provider.ts
│   │   └── composite.provider.ts
│   │
│   ├── db/
│   │   ├── connection.ts
│   │   ├── schema.ts
│   │   ├── migrate.ts
│   │   └── repositories/
│   │
│   ├── admin/                            # 管理 REST API
│   │   ├── routes.ts
│   │   ├── skills.controller.ts
│   │   └── schemas/
│   │
│   ├── cli/                              # CLI 命令
│   │   ├── index.ts                      # CLI 入口
│   │   ├── commands/
│   │   │   ├── import-cmd.ts             # import 命令
│   │   │   ├── list-cmd.ts              # list 命令
│   │   │   ├── remove-cmd.ts            # remove 命令
│   │   │   └── serve-cmd.ts             # serve 命令（启动服务）
│   │   └── utils.ts
│   │
│   ├── cloud/                            # 云端技能服务（拆分模式）
│   │   ├── server.ts                     # Cloud Skill Service 独立入口
│   │   ├── routes.ts                     # REST API 路由
│   │   ├── auth/
│   │   └── controllers/
│   │
│   ├── config/
│   │   ├── index.ts
│   │   └── schema.ts
│   │
│   └── utils/
│       ├── logger.ts
│       ├── errors.ts
│       ├── security.ts
│       └── manifest.ts
│
├── data/
├── tests/
├── scripts/
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## 10. 核心模块设计

### 10.1 MCP 协议层

#### 10.1.1 skill_file 批量读取实现

```typescript
// src/mcp/tools/skill-file.ts
server.tool(
  "skill_file",
  SKILL_FILE_DESC,
  {
    skill_slug: z.string().describe("技能唯一标识符（slug）"),
    file_paths: z.array(z.string())
      .describe("辅助文件路径数组，支持批量并发读取。"
        + "如 ['references/api-docs.md', 'templates/checklist.md']"),
  },
  async (params) => {
    const startTime = Date.now();
    const results = await services.skill.readSkillFiles(
      params.skill_slug, params.file_paths
    );
    const latencyMs = Date.now() - startTime;

    return {
      content: results.map(r => ({
        type: r.encoding === "base64" ? "image" : "text",
        text: r.content,
        ...(r.encoding === "base64" ? { mimeType: r.mimeType } : {}),
      })),
    };
  }
);
```

#### 10.1.2 SkillService 批量读取方法

```typescript
// src/services/skill.service.ts
async readSkillFiles(
  skillSlug: string,
  filePaths: string[]
): Promise<SkillFileContent[]> {
  // 1. 验证技能权限
  const skill = await this.skillProvider.getSkillMeta(skillSlug);
  if (!skill) throw new SkillNotFoundError(skillSlug);

  const allowed = await this.permissionFilter.check(skill.id);
  if (!allowed) throw new PermissionDeniedError(skillSlug);

  // 2. 路径安全校验
  const safePaths = filePaths.map(p => this.validatePath(p));

  // 3. 并发读取（缓存 → Provider）
  const results = await Promise.all(
    safePaths.map(async (path) => {
      const cacheKey = `skill:file:${skillSlug}:${path}`;

      // 缓存检查（仅文本文件）
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const isText = ["md", "txt", "json", "yaml", "py", "js"].includes(ext);

      if (isText) {
        const cached = await this.cache.get<string>(cacheKey);
        if (cached) return { path, content: cached, encoding: "utf-8" as const };
      }

      // 从 Provider 读取
      const files = await this.skillProvider.getSkillFiles(skillSlug, [path]);
      const file = files[0];

      // 文本文件写入缓存
      if (isText) {
        await this.cache.set(cacheKey, file.content, 600);
      }

      return { path, content: file.content, encoding: file.encoding, mimeType: file.mimeType };
    })
  );

  return results;
}
```

### 10.2 技能管理模块

SkillService 通过 `ISkillProvider` 接口操作数据，不直接依赖存储层。这使得单体模式和拆分模式可以使用同一套业务逻辑。

```typescript
export class SkillService {
  constructor(
    private skillProvider: ISkillProvider,   // 统一数据接口
    private cache: ICacheProvider,
    private permissionFilter: IPermissionFilter,
    private logger: Logger
  ) {}

  async listSkillsIndex(): Promise<string> {
    let skills = await this.skillProvider.listSkills();
    skills = await this.permissionFilter.filter(skills);

    // 平铺列表，按 slug 排序
    const sorted = skills
      .filter(s => s.status === "published")
      .sort((a, b) => a.slug.localeCompare(b.slug));

    const lines = sorted.map(s => {
      const desc = (s.description ?? "").length > 80
        ? s.description.slice(0, 77) + "..."
        : s.description;
      return `    - ${s.slug}: ${desc}`;
    });

    return lines.join("\n");
  }

  async viewSkillEntry(skillSlug: string): Promise<string> {
    const content = await this.skillProvider.getSkillEntry(skillSlug);

    // 安全扫描
    const scanResult = scanForInjection(content);
    if (!scanResult.safe) {
      this.logger.warn({ skillSlug, issues: scanResult.issues },
        "Skill content contains suspicious patterns");
    }

    const fileTree = await this.skillProvider.getSkillFileTree(skillSlug);
    const filePaths = fileTree
      .filter(f => f.path !== "SKILL.md" && f.path !== "manifest.json")
      .map(f => f.path).join(", ");

    return [
      `[SYSTEM: 用户正在使用 "${skillSlug}" 技能。以下为技能完整指令，请严格遵循执行。]`,
      ``,
      content,
      ``,
      filePaths ? `[可用辅助文件: ${filePaths}]` : "",
      filePaths ? `[提示: 使用 skill_file("${skillSlug}", ["文件路径1", "文件路径2"]) 批量加载]` : "",
    ].filter(Boolean).join("\n");
  }
}
```

### 10.3 技能导入模块（CLI + API）

```typescript
// src/import/importer.ts
export class SkillImporter {
  constructor(
    private skillProvider: ISkillProvider,
    private storage: IStorageProvider,
    private skillRepo: SkillRepository,
    private skillFileRepo: SkillFileRepository,
    private cache: ICacheProvider,
    private logger: Logger
  ) {}

  /**
   * 导入技能包
   * @param source 技能包来源（本地路径或 Git URL）
   * @param options 导入选项（分类、标签等元数据）
   */
  async import(source: string, options: ImportOptions): Promise<ImportResult> {
    // 1. 获取技能包文件
    const skillFiles = await this.resolveSource(source);

    // 2. 解析 manifest.json
    const manifest = this.parseManifest(skillFiles);
    this.validateManifest(manifest);

    // 3. 安全扫描
    const skillMd = skillFiles.find(f => f.path === manifest.entry ?? "SKILL.md");
    if (skillMd) {
      const scanResult = scanForInjection(skillMd.content);
      if (!scanResult.safe) throw new SecurityError(...);
    }

    // 4. 计算内容哈希
    const contentHash = await this.computeContentHash(skillFiles);

    // 5. 处理重名与版本
    const existing = await this.skillRepo.findByName(manifest.name);
    let targetSkill: Skill | null = null;
    let slug: string;
    let storagePath: string;

    if (options.targetId) {
      // 指定了目标 ID → 覆盖更新
      targetSkill = await this.skillRepo.findById(options.targetId);
      if (!targetSkill || targetSkill.name !== manifest.name) {
        throw new Error(`指定的 ID "${options.targetId}" 不存在或与技能名称 "${manifest.name}" 不匹配`);
      }
      // 检查内容是否变化
      if (targetSkill.contentHash === contentHash) {
        throw new Error(`技能 "${manifest.name}" 内容未变化，无需更新`);
      }
      slug = targetSkill.slug;
      storagePath = targetSkill.storagePath;
    } else if (existing.length > 0) {
      // 有重名但未指定 ID → 报错并列出选项
      throw new DuplicateSkillNameError(manifest.name, existing);
    } else {
      // 首次导入 → 生成 slug
      slug = this.generateSlug(manifest.name);
      storagePath = `skills/${slug}/`;
    }

    // 6. 写入存储层
    for (const file of skillFiles) {
      await this.storage.put(`${storagePath}${file.path}`, file.buffer);
    }

    // 7. 写入/更新 DB
    const meta: SkillMetaInput = {
      slug,
      name: manifest.name,
      description: options.description ?? ...,
      version: targetSkill
        ? this.bumpVersion(targetSkill.version, options.versionBump)
        : (manifest.version ?? "1.0.0"),
      storagePath,
      contentHash,
      // ... other fields
    };

    const skill = targetSkill
      ? await this.skillRepo.update(targetSkill.id, meta)
      : await this.skillRepo.create(meta);

    // 8. Clear cache
    await this.cache.clear();

    return { slug, name: manifest.name, version: meta.version, ... };
  }

  private generateSlug(name: string): string {
    // kebab-case, append short random suffix if name exists
    const base = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return base;
  }

  private async computeContentHash(files: SkillFileInput[]): Promise<string> {
    // Sort files by path, concatenate content, compute SHA-256
    const sorted = files.sort((a, b) => a.path.localeCompare(b.path));
    const hash = createHash('sha256');
    for (const f of sorted) {
      hash.update(f.path);
      hash.update(f.buffer);
    }
    return `sha256:${hash.digest('hex')}`;
  }

  private bumpVersion(current: string, bump?: 'major' | 'minor' | 'patch'): string {
    const [major, minor, patch] = current.split('.').map(Number);
    switch (bump ?? 'patch') {
      case 'major': return `${major + 1}.0.0`;
      case 'minor': return `${major}.${minor + 1}.0`;
      case 'patch': return `${major}.${minor}.${patch + 1}`;
    }
  }
}
```

```typescript
// src/import/git-source.ts
import simpleGit from "simple-git";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export class GitSourceResolver {
  async resolve(repoUrl: string): Promise<SkillFileInput[]> {
    // Clone 到临时目录
    const tmpDir = path.join(os.tmpdir(), `skill-import-${Date.now()}`);
    const git = simpleGit();

    await git.clone(repoUrl, tmpDir, ["--depth", "1"]);

    // 查找技能包根目录
    const skillDir = await this.findSkillRoot(tmpDir);

    // 读取所有文件
    const files = await this.readAllFiles(skillDir);

    // 清理临时目录
    await fs.rm(tmpDir, { recursive: true, force: true });

    return files;
  }

  private async findSkillRoot(dir: string): Promise<string> {
    // 优先查找包含 manifest.json 的目录
    if (await fs.access(path.join(dir, "manifest.json")).then(() => true).catch(() => false)) {
      return dir;
    }
    // 查找子目录
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(dir, entry.name);
        if (await fs.access(path.join(subDir, "manifest.json")).then(() => true).catch(() => false)) {
          return subDir;
        }
      }
    }
    return dir;
  }

  private async readAllFiles(dir: string): Promise<SkillFileInput[]> {
    const files: SkillFileInput[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if ([".git", "node_modules"].includes(entry.name)) continue;
        const subFiles = await this.readAllFiles(fullPath);
        files.push(...subFiles.map(f => ({
          ...f,
          path: `${entry.name}/${f.path}`,
        })));
      } else {
        const buffer = await fs.readFile(fullPath);
        files.push({ path: entry.name, buffer });
      }
    }
    return files;
  }
}
```

### 10.4 权限过滤模块

```typescript
// NoopFilter (MVP) 和 SubscriptionFilter (后续) 通过 IPermissionFilter 接口切换
// 网关-服务拆分模式下，权限由 Cloud Skill Service 负责
// Gateway 通过 RemoteSkillProvider 只能获取到已授权的技能数据
```

### 10.5 存储抽象层

与 v3 方案一致。`IStorageProvider` 接口 + `LocalFileSystemProvider` 实现 + `AliyunOSSProvider` 预留。

### 10.6 缓存抽象层

与 v3 方案一致。`ICacheProvider` 接口 + `CompositeCacheProvider`（L1 内存 LRU + L2 本地文件）。

### 10.7 数据访问层

与 v3 方案一致，`skills` 表新增 `slug`、`storage_path`、`content_hash`、`attributes` 字段。

---

## 11. 数据模型与数据库设计

### 11.1 核心表结构

```sql
-- 技能元数据表（服务端管理）
CREATE TABLE skills (
  id              TEXT PRIMARY KEY,           -- UUID
  slug            TEXT NOT NULL UNIQUE,       -- 唯一标识符（kebab-case，用于 API 调用和索引展示）
  name            TEXT NOT NULL,              -- 技能名称（可重复，匹配 manifest.name）
  display_name    TEXT,                       -- 管理员自定义展示名
  description     TEXT NOT NULL DEFAULT '',    -- 服务端索引描述
  version         TEXT NOT NULL DEFAULT '1.0.0',  -- 三位语义化版本号
  category        TEXT DEFAULT NULL,          -- 分类（可选，不再作为核心字段）
  tags            TEXT,                       -- JSON 数组：标签（可选）
  attributes      TEXT,                       -- JSON 对象：自定义属性键值对（灵活扩展）
  status          TEXT NOT NULL DEFAULT 'draft',
  visibility      TEXT NOT NULL DEFAULT 'public',
  entry_file      TEXT DEFAULT 'SKILL.md',
  storage_path    TEXT NOT NULL,              -- 技能文件物理存储目录路径
  content_hash    TEXT,                       -- 所有文件内容的 SHA-256 哈希（用于版本变更检测）
  conditions      TEXT,                       -- JSON: 条件激活规则
  assigned_groups TEXT,                       -- JSON: 权限分组
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- 技能文件表
CREATE TABLE skill_files (
  id              TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  file_type       TEXT NOT NULL,
  file_size       INTEGER NOT NULL,
  mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
  checksum        TEXT,
  created_at      INTEGER NOT NULL
);

-- 访问日志表
CREATE TABLE access_logs (
  id              TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL REFERENCES skills(id),
  skill_slug      TEXT NOT NULL,
  action          TEXT NOT NULL,               -- list | view_entry | read_files
  file_paths      TEXT,                        -- JSON: 批量路径
  latency_ms      INTEGER,
  created_at      INTEGER NOT NULL
);

-- 索引
CREATE UNIQUE INDEX idx_skills_slug ON skills(slug);
CREATE INDEX idx_skills_name ON skills(name);
CREATE INDEX idx_skills_status ON skills(status);
CREATE INDEX idx_skills_visibility ON skills(visibility);
CREATE INDEX idx_skill_files_skill_id ON skill_files(skill_id);
CREATE INDEX idx_access_logs_created_at ON access_logs(created_at);
```

**`attributes` 字段说明**：

`attributes` 是一个灵活的 JSON 对象字段，用于存储技能的自定义扩展属性。管理员可以根据需要添加任意键值对，用于技能的筛选、分类和展示：

```json
{
  "language": "zh-CN",
  "complexity": "advanced",
  "framework": "react",
  "author": "team-a"
}
```

通过 Admin API 进行筛选时，支持按 attributes 中的键值对过滤：
```
GET /api/skills?attributes.language=zh-CN&attributes.complexity=advanced
```

---

## 12. MCP Tool 接口设计

### 12.1 Tool 总览

| Tool | 用途 | 参数 | 批量支持 |
|------|------|------|---------|
| `skill_list` | 轻量技能索引 | (无参数) | - |
| `skill_view` | 加载 SKILL.md | `skill_slug` | - |
| `skill_file` | 读取辅助文件 | `skill_slug`, `file_paths[]` | 支持数组 |

> **注意**：`skill_list` 不再接受 `category` 参数，因为索引为平铺列表（不分组）。分类和标签筛选通过 Admin API 提供。

### 12.2 skill_file 批量请求示例

**请求**：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "skill_file",
    "arguments": {
      "skill_slug": "prompt-writer",
      "file_paths": [
        "references/crispe-framework.md",
        "templates/checklist.md",
        "templates/output-template.md"
      ]
    }
  }
}
```

**响应**（3 个文件内容在一次响应中返回）：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "# CRISPE Framework\n\n## Capacity\n..."
      },
      {
        "type": "text",
        "text": "# 自检清单\n\n- [ ] 明确了目标..."
      },
      {
        "type": "text",
        "text": "# 输出模板\n\n## 提示词\n..."
      }
    ]
  }
}
```

**优势**：原来需要 3 次 Tool 调用（3 轮请求-响应），现在只需 1 次，显著降低延迟。

---

## 13. 管理 REST API 设计

### 13.1 技能管理 API

| 方法 | 路径 | 描述 |
|------|------|------|
| `GET` | `/api/skills` | 获取技能列表（支持分页、分类筛选 `?category=writing&tags=prompt&attributes.language=zh-CN`） |
| `GET` | `/api/skills/:slug` | 获取技能详情（含文件树） |
| `GET` | `/api/skills/name/:name` | 按名称搜索（可能返回多个，列出所有同名技能的 slug + version） |
| `POST` | `/api/skills` | 上传技能包（ZIP 格式） |
| `PUT` | `/api/skills/:slug` | **更新技能元数据**（分类、标签、描述、可见性、权限分组、自定义属性） |
| `DELETE` | `/api/skills/:slug` | 删除技能 |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/stats` | 系统统计信息 |

### 13.2 更新技能元数据（职责分离的关键 API）

```
PUT /api/skills/:slug
Content-Type: application/json

{
  "display_name": "提示词编写专家",
  "description": "专业级提示词编写与优化",
  "category": "writing",
  "tags": ["prompt-engineering", "creative"],
  "attributes": {"language": "zh-CN", "complexity": "advanced"},
  "visibility": "public",
  "assigned_groups": ["all-staff"]
}

Response 200:
{
  "success": true,
  "data": {
    "slug": "prompt-writer",
    "name": "prompt-writer",
    "display_name": "提示词编写专家",
    "category": "writing",
    "tags": ["prompt-engineering", "creative"],
    "attributes": {"language": "zh-CN", "complexity": "advanced"},
    "updated_at": "2026-04-24T10:00:00Z"
  }
}
```

**注意**：此 API 只修改服务端元数据，不影响技能包文件内容。

### 13.3 按名称搜索同名技能

```
GET /api/skills/name/:name

Response 200:
{
  "success": true,
  "data": [
    {
      "slug": "prompt-writer",
      "name": "prompt-writer",
      "version": "1.0.0",
      "status": "published",
      "updated_at": "2026-04-24T10:00:00Z"
    },
    {
      "slug": "prompt-writer-v2",
      "name": "prompt-writer",
      "version": "2.0.0",
      "status": "published",
      "updated_at": "2026-04-20T08:00:00Z"
    }
  ]
}
```

---

## 14. CLI 命令设计

CLI 在 stdio 模式下尤为重要，因为它提供了不依赖 HTTP API 的本地操作能力。

### 14.1 命令总览

```bash
# 启动 MCP Server
skill-mcp serve --transport stdio               # stdio 模式（默认）
skill-mcp serve --transport sse --port 3000      # SSE 模式
skill-mcp serve --transport http --port 3000     # HTTP 模式

# 技能导入
skill-mcp import ./local-skill-dir \
  --category writing \
  --tags "prompt,creative" \
  --description "专业提示词编写"

skill-mcp import ./local-skill-dir \
  --id "uuid-of-existing" \         # 指定覆盖目标
  --version-bump minor               # 版本升级类型: major|minor|patch

skill-mcp import https://github.com/user/skill-repo  # 从 Git 仓库导入
skill-mcp import git@github.com:user/skill-repo.git  # SSH 格式
skill-mcp import https://github.com/user/skill-repo \
  --branch v2.0 \                                # 指定分支
  --sub-dir skills/prompt-writer                 # 指定子目录

# 技能列表
skill-mcp list                          # 列出所有技能（slug + description）
skill-mcp list --name prompt-writer     # 搜索同名技能
skill-mcp list --tags prompt            # 按标签筛选

# 技能详情
skill-mcp info prompt-writer            # 通过 slug 查看详情

# 按名称搜索
skill-mcp search --name prompt-writer   # 搜索同名技能

# 技能删除
skill-mcp remove prompt-writer [--force]

# 技能元数据更新
skill-mcp update prompt-writer \
  --category writing \
  --tags "prompt,creative,advanced" \
  --description "专业级提示词编写与优化"
```

### 14.2 CLI 入口实现

```typescript
// src/cli/index.ts
import { Command } from "commander";

const program = new Command()
  .name("skill-mcp")
  .description("Cloud Skill File System & MCP Permission Gateway")
  .version(config.app.version);

// serve 命令
program
  .command("serve")
  .description("Start MCP Server")
  .option("--transport <type>", "Transport type: stdio|sse|http", "stdio")
  .option("--port <number>", "HTTP port (for sse/http)", "3000")
  .option("--mode <mode>", "Deployment mode: standalone|gateway", "standalone")
  .action(async (options) => {
    await startServer(options);
  });

// import 命令
program
  .command("import <source>")
  .description("Import a skill package from local path or Git repo")
  .option("--category <category>", "Server-side category")
  .option("--tags <tags>", "Server-side tags (comma-separated)")
  .option("--description <desc>", "Server-side description")
  .option("--id <id>", "Target skill ID for overwrite update")
  .option("--version-bump <type>", "Version bump type: major|minor|patch", "patch")
  .option("--overwrite", "Overwrite if skill exists")
  .option("--branch <branch>", "Git branch (for git sources)")
  .option("--sub-dir <path>", "Sub-directory within git repo")
  .action(async (source, options) => {
    const importer = createImporter();
    await importer.import(source, options);
  });

// list 命令
program.command("list")
  .option("--name <name>", "Filter by skill name")
  .option("--tags <tags>", "Filter by tags")
  .action(async (options) => {
    // 列出技能及其服务端元数据
  });

// info 命令
program.command("info <slug>")
  .description("Show skill details by slug")
  .action(async (slug) => {
    // 显示技能详情和文件树
  });

// search 命令
program.command("search")
  .description("Search skills by name")
  .requiredOption("--name <name>", "Skill name to search")
  .action(async (options) => {
    // 搜索同名技能
  });

// remove 命令
program.command("remove <slug>")
  .option("--force", "Skip confirmation")
  .action(async (slug, options) => {
    // 删除技能
  });

// update 命令
program.command("update <slug>")
  .option("--category <category>", "Update category")
  .option("--tags <tags>", "Update tags")
  .option("--description <desc>", "Update description")
  .action(async (slug, options) => {
    // 更新服务端元数据
  });

program.parse();
```

### 14.3 CLI 与 stdio 模式的协同

在 stdio 模式下，MCP Server 作为子进程运行时，CLI 命令通过同一个可执行文件的**不同入口点**提供：

```
同一个可执行文件 skill-mcp，两种使用方式：

方式 1: 作为 MCP Server（由 MCP Client 启动）
  skill-mcp serve --transport stdio
  → 启动 stdio 传输，进入 MCP 协议循环

方式 2: 作为 CLI 工具（由用户手动执行）
  skill-mcp import ./my-skill
  → 执行导入操作后退出
  skill-mcp list
  → 显示技能列表后退出
```

---

## 15. 配置管理

```typescript
export const configSchema = z.object({
  app: z.object({
    name: z.string().default("skill-mcp-server"),
    version: z.string().default("1.0.0"),
    env: z.enum(["development", "production", "test"]).default("development"),
  }),

  // 部署模式
  deployment: z.object({
    mode: z.enum(["standalone", "gateway"]).default("standalone"),
  }),

  // 仅 gateway 模式
  gateway: z.object({
    cloudServiceUrl: z.string().url(),
    authToken: z.string(),
    authTokenRefreshUrl: z.string().optional(),
  }).optional(),

  // 存储
  storage: z.discriminatedUnion("type", [
    z.object({ type: z.literal("local-fs"), basePath: z.string().default("./data/skills") }),
    z.object({ type: z.literal("aliyun-oss"), bucket: z.string(), region: z.string() }),
  ]).default({ type: "local-fs", basePath: "./data/skills" }),

  // 数据库
  database: z.object({
    path: z.string().default("./data/skill-mcp.db"),
  }),

  // 缓存
  cache: z.object({
    memory: z.object({ enabled: z.boolean().default(true), maxSize: z.number().default(500) }),
    file: z.object({ enabled: z.boolean().default(true), cacheDir: z.string().default("./data/cache") }),
  }).default({}),

  // 传输
  transport: z.object({
    type: z.enum(["stdio", "sse", "http"]).default("stdio"),
    port: z.number().default(3000),
    host: z.string().default("0.0.0.0"),
  }).default({}),

  // 安全
  security: z.object({
    enableInjectionScan: z.boolean().default(true),
  }).default({}),
});
```

---

## 16. 错误处理与日志

与 v3 方案一致。错误类体系 + MCP 错误响应格式 + Pino 结构化日志。

---

## 17. 部署方案

### 17.1 MCP Client 集成配置

```json
{
  "mcpServers": {
    "skill-mcp-stdio": {
      "command": "node",
      "args": ["dist/index.js", "serve", "--transport", "stdio"]
    },
    "skill-mcp-sse": {
      "url": "https://mcp.example.com/mcp/sse",
      "headers": { "Authorization": "Bearer sk-xxx" }
    },
    "skill-mcp-http": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer sk-xxx" }
    }
  }
}
```

### 17.2 单体部署 vs 网关-服务拆分部署

**单体部署**（一个进程）：
```bash
skill-mcp serve --transport stdio --mode standalone
skill-mcp serve --transport sse --port 3000 --mode standalone
```

**网关-服务拆分部署**（两个进程）：
```bash
# 端 1: 云端技能服务
skill-mcp cloud-serve --port 8080 --storage aliyun-oss

# 端 2: MCP 网关（靠近模型）
skill-mcp serve --transport stdio --mode gateway \
  --cloud-url https://skill-api.example.com \
  --auth-token sk-xxx
```

---

## 18. 实施路线图

### 第一阶段：核心（第 1-2 周）

| 任务 | 包含 |
|------|------|
| 项目骨架 | pnpm + TS + ESLint + 配置管理 |
| 数据库 + 存储 + 缓存 | SQLite + LocalFS + 多级缓存 |
| ISkillProvider 接口 | LocalSkillProvider 实现 |
| MCP 协议层 | stdio 传输 + 3 个 Tool（含批量 skill_file） |
| 遵循度引擎 | instructions + Tool Description + 激活引导 |
| CLI 基础命令 | import (本地) + list + info + remove + serve |

### 第二阶段：传输 + 导入（第 3 周）

| 任务 | 包含 |
|------|------|
| SSE 传输 | Fastify SSE 插件 + MCP SSE transport |
| HTTP 传输 | StreamableHTTP transport |
| Git 导入 | simple-git + 临时目录 + 子目录支持 |
| 元数据管理 API | PUT /api/skills/:slug 更新分类/标签/属性 |
| 安全扫描 | prompt injection 模式匹配 |

### 第三阶段：拆分模式（第 4 周）

| 任务 | 包含 |
|------|------|
| RemoteSkillProvider | HTTPS 调用云端服务 |
| Cloud Skill Service | 独立 REST API 服务 |
| 鉴权转发 | Gateway → Cloud token 传递 |
| 权限过滤 | SubscriptionFilter 实现 |
| Gateway 缓存策略 | 已授权技能缓存 + 文件缓存 |

### 第四阶段：测试 + 文档（第 5 周）

| 任务 | 包含 |
|------|------|
| 单元测试 | 覆盖率 > 80% |
| 集成测试 | MCP Tools + Admin API + CLI |
| 遵循度测试 | 多模型遵循度评估 |
| 部署文档 | 单体 + 拆分两种模式 |
| 集成文档 | Claude Desktop / Cursor / Web IDE |

---

## 19. 扩展预留与演进路径

| 扩展点 | 当前实现 | 未来方向 |
|--------|---------|---------|
| 存储 | 本地文件 | 阿里云 OSS / S3 |
| 缓存 | 内存 + 文件 | Redis |
| 数据库 | SQLite | PostgreSQL |
| 权限 | NoopFilter | SubscriptionFilter / RBACFilter |
| 认证 | 无 | JWT / API Key / OAuth2 |
| 加密 | 无 | AES-256 + KMS |
| 技能市场 | 无 | 搜索 / 评分 / 推荐 / Dashboard |
