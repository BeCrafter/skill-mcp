# Skill 编排引擎技术文档

> 版本：1.0 | 日期：2026-04-30

---

## 1. 概述

### 1.1 设计理念

Skill 编排引擎的核心定位是 **"让 AI Agent 能按 DAG（有向无环图）顺序调用多个 Skill"**，而不是做一个通用的工作流引擎。

```
传统 Workflow 引擎:  用户 → 定义流程 → 引擎执行任务 → 返回结果
                    (人类操作)

Skill 编排引擎:      AI Agent → 定义 Pipeline → 引擎调度 Skill → Agent 执行
                    (AI 调度)                     ↑
                                               重点：引擎只负责调度，
                                               不负责执行 Skill 内容
```

### 1.2 与通用 Workflow 引擎的区别

| 特性 | Skill 编排引擎 | 通用 Workflow 引擎 |
|------|---------------|-------------------|
| 目标用户 | AI Agent | 人类开发者 |
| 执行者 | Agent 自己执行 | Worker 节点执行 |
| 复杂度 | 轻量（~300 行） | 重量级（数万行） |
| 状态管理 | 内存（无持久化） | 数据库持久化 |
| 设计目标 | 调度 + 数据流 | 完整的任务执行 |

---

## 2. 核心概念

### 2.1 Pipeline（管道）

一个 Pipeline 是多个 Stage 的有序组合，用 YAML 定义：

```yaml
name: code-review-pipeline          # 管道名称
description: 自动化代码审查

inputs:                             # 输入参数定义
  pr_url:
    type: string
    required: true

stages:                             # 阶段定义（核心）
  read-pr:
    skill: github-pr-reader         # 绑定的 skill slug
    inputs:
      url: ${{ inputs.pr_url }}     # 表达式引用输入
    outputs: [diff, files]          # 输出声明

  security-scan:
    skill: security-scanner
    depends_on: [read-pr]           # 依赖关系 → 形成 DAG
    inputs:
      code: ${{ stages.read-pr.outputs.diff }}  # 引用上游输出
    outputs: [vulnerabilities]

output:                             # 最终输出
  report: ${{ stages.security-scan.outputs.vulnerabilities }}
```

### 2.2 Stage（阶段）

每个 Stage 绑定一个 Skill，定义了：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `skill` | string | Yes | 要调用的 skill slug |
| `depends_on` | string[] | No | 依赖的其他 stage |
| `inputs` | object | Yes | 输入参数（可用表达式） |
| `outputs` | string[] | Yes | 声明输出的字段名 |
| `condition` | string | No | 条件执行（预留，未实现） |
| `retry` | object | No | 重试策略（预留，未实现） |

### 2.3 DAG（有向无环图）

通过 `depends_on` 建立依赖关系：

```
read-pr
   ├── security-scan ─────┐
   └── style-check ───────┼──► generate-report
                          │
```

**DAG 的作用**：
1. 确定执行顺序（拓扑排序）
2. 识别可并行执行的 stage（同一层的 stage）
3. 检测环路（循环依赖会报错）

---

## 3. 代码架构

### 3.1 目录结构

```
src/pipeline/
├── types.ts      # 类型定义
├── parser.ts     # YAML 解析 + 验证
├── dag.ts        # DAG 构建 + 拓扑排序 + 环检测
├── context.ts    # 执行上下文（表达式解析 + 数据传递）
└── executor.ts   # 执行引擎（调度逻辑）
```

### 3.2 DAGScheduler（dag.ts）

核心调度器，负责拓扑排序和环检测：

```typescript
class DAGScheduler {
  // 返回可并行执行的批次
  getBatches(): string[][] {
    // 使用 Kahn's 算法进行拓扑排序
    // 返回: [["read-pr"], ["security-scan", "style-check"], ["generate-report"]]
    //       ^第1批        ^第2批（可并行）                   ^第3批
  }

  // 检测循环依赖
  detectCycles(): void {
    // DFS 检测环，发现环路抛出错误
  }
}
```

**执行流程**：
```
Batch 1: [read-pr]                    → 串行执行
Batch 2: [security-scan, style-check] → 并行执行
Batch 3: [generate-report]            → 等 Batch 2 完成后执行
```

### 3.3 ExecutionContext（context.ts）

负责解析 `${{ }}` 表达式，在 Stage 间传递数据：

```typescript
class ExecutionContext {
  // 存储每个 stage 的输出
  private stageOutputs: Map<string, Record<string, unknown>>;

  // 解析表达式
  resolveExpression(expr: string): unknown {
    // "${{ inputs.pr_url }}" → 返回输入值
    // "${{ stages.read-pr.outputs.diff }}" → 返回 read-pr 的 diff 输出
  }
}
```

**支持的表达式**：

| 表达式 | 含义 |
|--------|------|
| `${{ inputs.xxx }}` | 引用 Pipeline 输入参数 |
| `${{ stages.xxx.outputs }}` | 引用某 stage 的全部输出 |
| `${{ stages.xxx.outputs.yyy }}` | 引用某 stage 的特定输出字段 |

### 3.4 PipelineExecutor（executor.ts）

执行引擎，负责调度逻辑：

```typescript
class PipelineExecutor {
  async execute(pipeline, inputs): Promise<PipelineResult> {
    const dag = new DAGScheduler(pipeline.stages);
    const context = new ExecutionContext(inputs);

    for (const batch of dag.getBatches()) {
      // 同一批次的 stage 并行执行
      const batchResults = await Promise.allSettled(
        batch.map(stageName => this.executeStage(...))
      );

      // 将输出存入 context，供下游 stage 使用
      context.setStageOutputs(stageName, result.outputs);
    }
  }
}
```

**关键设计决策**：引擎不真正执行 Skill，只返回 skill 内容和解析后的输入，真正的执行由 AI Agent 完成。

---

## 4. YAML 定义格式

### 4.1 完整示例

```yaml
name: code-review-pipeline
description: Automated code review with security and style checks

inputs:
  pr_url:
    type: string
    required: true
  severity_threshold:
    type: string
    required: false
    default: "medium"

stages:
  read-pr:
    skill: github-pr-reader
    inputs:
      url: ${{ inputs.pr_url }}
    outputs: [diff, files, metadata]

  security-scan:
    skill: security-scanner
    depends_on: [read-pr]
    inputs:
      code: ${{ stages.read-pr.outputs.diff }}
      threshold: ${{ inputs.severity_threshold }}
    outputs: [vulnerabilities, risk_level]

  style-check:
    skill: style-checker
    depends_on: [read-pr]
    inputs:
      files: ${{ stages.read-pr.outputs.files }}
    outputs: [violations, suggestions]

  generate-report:
    skill: report-writer
    depends_on: [security-scan, style-check]
    inputs:
      security: ${{ stages.security-scan.outputs }}
      style: ${{ stages.style-check.outputs }}
      metadata: ${{ stages.read-pr.outputs.metadata }}
    outputs: [report]

output:
  report: ${{ stages.generate-report.outputs.report }}
  risk_level: ${{ stages.security-scan.outputs.risk_level }}
```

### 4.2 字段说明

| 顶级字段 | 类型 | 必填 | 说明 |
|---------|------|------|------|
| `name` | string | Yes | Pipeline 名称 |
| `description` | string | No | 描述 |
| `inputs` | object | No | 输入参数定义 |
| `stages` | object | Yes | Stage 定义映射 |
| `output` | object | No | 最终输出表达式 |

### 4.3 表达式语法

```
${{ <scope>.<path> }}

Scope:
  - inputs     → Pipeline 输入参数
  - stages     → Stage 输出

Path:
  - inputs.xxx                    → 输入参数 xxx
  - stages.xxx.outputs            → Stage xxx 的全部输出
  - stages.xxx.outputs.yyy        → Stage xxx 的 yyy 字段
```

---

## 5. 使用方式

### 5.1 CLI 命令

```bash
# 验证 Pipeline 定义
skill-mcp pipeline validate <yaml-path>
# 输出:
# ✓ Pipeline "code-review" is valid
#   Stages: 4
#   Batches: 3 (max parallelism: 2)
#   Inputs: 2
#   Outputs: 2

# 可视化 DAG
skill-mcp pipeline graph <yaml-path>
# 输出:
# Pipeline: code-review-pipeline
# Description: Automated code review with security and style checks
#
# Batch 1 (parallel execution):
#   read-pr [skill: github-pr-reader]
#
# Batch 2 (parallel execution):
#   security-scan [skill: security-scanner] ← depends on: read-pr
#   style-check [skill: style-checker] ← depends on: read-pr
#
# Batch 3 (parallel execution):
#   generate-report [skill: report-writer] ← depends on: security-scan, style-check

# 执行 Pipeline（dry-run）
skill-mcp pipeline run <yaml-path> --input pr_url=https://... --dry-run
```

### 5.2 MCP 工具

AI Agent 可通过 `skill_pipeline` MCP Tool 调用：

```json
{
  "tool": "skill_pipeline",
  "arguments": {
    "pipeline": "name: quick-review\ninputs:\n  pr_url:\n    type: string\n    required: true\nstages:\n  ...",
    "inputs": {
      "pr_url": "https://github.com/owner/repo/pull/123"
    }
  }
}
```

返回结果：
```json
{
  "name": "quick-review",
  "status": "success",
  "stages": [
    {
      "stage": "read-pr",
      "status": "success",
      "outputs": { "skill_entry": "...", "resolved_inputs": {...} },
      "duration_ms": 45
    }
  ],
  "output": {...},
  "total_duration_ms": 120
}
```

---

## 6. 优缺点分析

### 6.1 优点

| 优点 | 说明 |
|------|------|
| **并行执行** | 无依赖的 stage 自动并行，提高效率 |
| **类型安全** | TypeScript 类型定义完整，IDE 友好 |
| **环路检测** | 编译时检测循环依赖，避免死循环 |
| **表达式系统** | `${{ }}` 语法直观，类似 GitHub Actions |
| **与 Skill 解耦** | 引擎不关心 skill 具体内容，只负责调度 |
| **CLI 支持** | `pipeline validate/graph/run --dry-run` 方便调试 |
| **轻量级** | 核心代码 ~300 行，易于理解和维护 |

### 6.2 当前限制

| 限制 | 说明 | 改进方向 |
|------|------|----------|
| **不执行 Skill** | 只返回 skill 内容，真正执行靠 Agent | 可增加 callback 机制让 Agent 回填输出 |
| **无条件执行** | `condition` 字段预留但未实现 | 可加 `if: ${{ xxx == 'value' }}` |
| **无重试机制** | `retry` 字段预留但未实现 | 可加 exponential backoff |
| **无持久化** | 执行状态只在内存，中断后丢失 | 可加 DB 持久化 |
| **无可视化** | CLI 只有 ASCII 图，无 Web UI | 可加 Mermaid/D3 图形化 |
| **表达式简单** | 不支持复杂逻辑（if/else、数组操作）| 可集成 JSONata/jq |

### 6.3 与其他编排工具对比

| 特性 | Skill Pipeline | GitHub Actions | Airflow | Temporal |
|------|---------------|----------------|---------|----------|
| 目标用户 | AI Agent | CI/CD | 数据工程 | 分布式系统 |
| 定义语言 | YAML | YAML | Python | Go/Java/Python |
| 执行者 | Agent 自己 | Runner | Worker | Worker |
| 并行支持 | Yes | Yes | Yes | Yes |
| 条件执行 | No (预留) | Yes | Yes | Yes |
| 重试 | No (预留) | Yes | Yes | Yes |
| 持久化 | No | Yes | Yes | Yes |
| 复杂度 | 低 | 中 | 高 | 高 |

---

## 7. 扩展路径

### 7.1 条件执行

```yaml
stages:
  security-scan:
    skill: security-scanner
    depends_on: [read-pr]
    condition: ${{ stages.read-pr.outputs.files_changed > 0 }}  # 未实现
    inputs:
      code: ${{ stages.read-pr.outputs.diff }}
    outputs: [vulnerabilities]
```

### 7.2 重试机制

```yaml
stages:
  external-api-call:
    skill: api-caller
    retry:                    # 未实现
      max: 3
      delay_ms: 1000
      backoff: exponential
    inputs:
      endpoint: ${{ inputs.api_url }}
    outputs: [response]
```

### 7.3 持久化

```typescript
// 未来可扩展
interface PipelineExecution {
  id: string;
  pipeline_name: string;
  status: 'running' | 'success' | 'failed';
  stages: StageExecution[];
  created_at: number;
  updated_at: number;
}
```

---

## 8. 相关文件

- `src/pipeline/types.ts` - 类型定义
- `src/pipeline/parser.ts` - YAML 解析器
- `src/pipeline/dag.ts` - DAG 调度器
- `src/pipeline/context.ts` - 执行上下文
- `src/pipeline/executor.ts` - 执行引擎
- `src/mcp/tools/skill-pipeline.ts` - MCP Tool 定义
- `src/cli/commands/pipeline-cmd.ts` - CLI 命令
- `tests/unit/pipeline/` - 单元测试
