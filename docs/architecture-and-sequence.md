# Skill MCP 架构图与时序图

> 基于 Mermaid 语法，涵盖系统架构、组件依赖、核心操作时序

---

## 目录

- [1. 系统分层架构图](#1-系统分层架构图)
- [2. 组件依赖关系图](#2-组件依赖关系图)
- [3. 数据库 ER 图](#3-数据库-er-图)
- [4. 缓存架构图](#4-缓存架构图)
- [5. 导入流水线时序图](#5-导入流水线时序图)
- [6. MCP 工具调用时序图](#6-mcp-工具调用时序图)
  - [6.1 skill_list](#61-skill_list)
  - [6.2 skill_view](#62-skill_view)
  - [6.3 skill_file](#63-skill_file)
- [7. 配置加载时序图](#7-配置加载时序图)
- [8. 传输层初始化时序图](#8-传输层初始化时序图)
  - [8.1 stdio 模式](#81-stdio-模式)
  - [8.2 SSE / HTTP 模式](#82-sse--http-模式)
- [9. 安全扫描流程图](#9-安全扫描流程图)
- [10. 权限过滤流程图](#10-权限过滤流程图)

---

## 1. 系统分层架构图

```mermaid
graph TB
  subgraph 客户端
    CLI[CLI 命令行<br/>serve / import / list / ...]
    MCPClient[MCP 客户端<br/>Claude / Cursor / ...]
    HTTPClient[HTTP 客户端<br/>Admin REST API]
  end

  subgraph 接入层
    Commander[Commander CLI 框架]
    McpServer[McpServer<br/>+ Tool 注册]
    HTTPServer[Node HTTP Server<br/>/api/* + /mcp/*]
  end

  subgraph 传输层
    StdioTransport[StdioServerTransport]
    SSETransport[SSEServerTransport]
    HTTPTransport[StreamableHTTPServerTransport]
  end

  subgraph 业务层
    SkillService[SkillService<br/>核心业务逻辑]
    SkillImporter[SkillImporter<br/>导入流水线]
    AccessLogService[AccessLogService<br/>访问日志]
    PromptBuilder[Prompt Builder<br/>系统提示词 + Tool 描述]
  end

  subgraph 横切关注点
    PermissionFilter[IPermissionFilter<br/>权限过滤]
    SecurityScanner[Security Scanner<br/>注入扫描 + 路径校验]
  end

  subgraph 提供者层
    ISkillProvider[[ISkillProvider]]
    LocalProvider[LocalSkillProvider]
    RemoteProvider[RemoteSkillProvider]
  end

  subgraph 存储层
    IStorageProvider[[IStorageProvider]]
    LocalFS[LocalFileSystemProvider<br/>data/skills/]
  end

  subgraph 缓存层
    CompositeCache[CompositeCacheProvider]
    L1[L1: MemoryLRUCache]
    L2[L2: FileCache]
  end

  subgraph 数据层
    DB[(SQLite<br/>better-sqlite3)]
    SkillRepo[SkillRepository]
    SkillFileRepo[SkillFileRepository]
    AccessLogRepo[AccessLogRepository]
  end

  subgraph 基础设施
    Config[Config 单例<br/>Zod 校验]
    Logger[Pino Logger]
    GitSource[GitSourceResolver<br/>simple-git]
    LocalSource[LocalSourceResolver]
  end

  CLI --> Commander
  MCPClient --> McpServer
  HTTPClient --> HTTPServer

  Commander --> SkillService
  Commander --> SkillImporter
  McpServer --> SkillService
  HTTPServer --> SkillService
  HTTPServer --> McpServer

  McpServer --> StdioTransport
  McpServer --> SSETransport
  McpServer --> HTTPTransport

  SkillService --> ISkillProvider
  SkillService --> PermissionFilter
  SkillService --> SecurityScanner
  SkillService --> AccessLogService
  SkillService --> CompositeCache
  SkillImporter --> LocalSource
  SkillImporter --> GitSource
  SkillImporter --> SecurityScanner
  SkillImporter --> CompositeCache

  ISkillProvider -.-> LocalProvider
  ISkillProvider -.-> RemoteProvider

  LocalProvider --> IStorageProvider
  LocalProvider --> CompositeCache
  LocalProvider --> SkillRepo
  RemoteProvider --> CompositeCache

  IStorageProvider -.-> LocalFS

  CompositeCache --> L1
  CompositeCache --> L2

  SkillRepo --> DB
  SkillFileRepo --> DB
  AccessLogRepo --> DB
  AccessLogService --> AccessLogRepo
```

## 2. 组件依赖关系图

```mermaid
graph LR
  subgraph src/index.ts
    main["main()"]
  end

  subgraph src/config
    loadConfig["loadConfig()"]
    configSchema["configSchema (Zod)"]
  end

  subgraph src/cli
    createCli["createCli()"]
    serveAction["serveAction()"]
    importAction["importAction()"]
  end

  subgraph src/app.ts
    createApp["createApp()"]
    handleAdmin["handleAdminRoute()"]
  end

  subgraph src/mcp
    createMcpServer["createMcpServer()"]
    registerTools["registerTools()"]
    createTransport["createTransport()"]
  end

  subgraph src/services
    SkillService["SkillService"]
    AccessLogService["AccessLogService"]
  end

  subgraph src/provider
    LocalProvider["LocalSkillProvider"]
    RemoteProvider["RemoteSkillProvider"]
  end

  subgraph src/storage
    LocalFS["LocalFileSystemProvider"]
  end

  subgraph src/cache
    CompositeCache["CompositeCacheProvider"]
    MemoryLRU["MemoryLRUCacheProvider"]
    FileCache["FileCacheProvider"]
  end

  subgraph src/import
    Importer["SkillImporter"]
    LocalSource["LocalSourceResolver"]
    GitSource["GitSourceResolver"]
    Validator["validateSkillPackage()"]
  end

  subgraph src/db
    DB["getDatabase()"]
    Migrate["runMigrations()"]
    SkillRepo["SkillRepository"]
    SkillFileRepo["SkillFileRepository"]
    AccessLogRepo["AccessLogRepository"]
  end

  subgraph src/permission
    GroupFilter["GroupPermissionFilter"]
    NoopFilter["NoopPermissionFilter"]
  end

  subgraph src/utils
    Security["security.ts"]
    Manifest["manifest.ts"]
    Errors["errors.ts"]
  end

  subgraph src/prompt
    SystemPrompt["buildSkillSystemPrompt()"]
    Descriptions["tool descriptions"]
  end

  main --> loadConfig
  loadConfig --> configSchema
  main --> createCli
  createCli --> serveAction
  createCli --> importAction

  serveAction --> DB
  serveAction --> Migrate
  serveAction --> CompositeCache
  serveAction --> LocalFS
  serveAction --> LocalProvider
  serveAction --> SkillService
  serveAction --> createMcpServer
  serveAction --> createApp

  createMcpServer --> SystemPrompt
  createMcpServer --> registerTools
  registerTools --> Descriptions

  createApp --> createMcpServer
  createApp --> createTransport
  createApp --> handleAdmin

  SkillService --> LocalProvider
  SkillService --> GroupFilter
  SkillService --> Security
  SkillService --> AccessLogService

  LocalProvider --> SkillRepo
  LocalProvider --> LocalFS
  LocalProvider --> CompositeCache

  RemoteProvider --> CompositeCache

  CompositeCache --> MemoryLRU
  CompositeCache --> FileCache

  Importer --> LocalSource
  Importer --> GitSource
  Importer --> Validator
  Importer --> SkillRepo
  Importer --> SkillFileRepo
  Importer --> LocalFS
  Importer --> CompositeCache

  Validator --> Security
  LocalSource --> Manifest
  GitSource --> Manifest

  AccessLogService --> AccessLogRepo
  SkillRepo --> DB
  SkillFileRepo --> DB
  AccessLogRepo --> DB
```

## 3. 数据库 ER 图

```mermaid
erDiagram
  skills {
    TEXT id PK
    TEXT slug UK "NOT NULL UNIQUE"
    TEXT name "NOT NULL"
    TEXT display_name
    TEXT description "DEFAULT ''"
    TEXT version "DEFAULT '1.0.0'"
    TEXT category
    TEXT tags "JSON array"
    TEXT attributes "JSON object"
    TEXT status "draft|published|deprecated|archived"
    TEXT visibility "public|private|internal"
    TEXT entry_file "DEFAULT 'SKILL.md'"
    TEXT storage_path "NOT NULL"
    TEXT content_hash
    TEXT conditions "JSON"
    TEXT assigned_groups "JSON array"
    INTEGER created_at "NOT NULL"
    INTEGER updated_at "NOT NULL"
  }

  skill_files {
    TEXT id PK
    TEXT skill_id FK "NOT NULL"
    TEXT file_path "NOT NULL"
    TEXT file_type "NOT NULL text|binary"
    INTEGER file_size "NOT NULL"
    TEXT mime_type "DEFAULT 'application/octet-stream'"
    TEXT checksum
    INTEGER created_at "NOT NULL"
  }

  access_logs {
    TEXT id PK
    TEXT skill_id FK "NOT NULL"
    TEXT skill_slug "NOT NULL"
    TEXT action "NOT NULL list|view_entry|read_files"
    TEXT file_paths "JSON array"
    INTEGER latency_ms
    INTEGER created_at "NOT NULL"
  }

  skills ||--o{ skill_files : "has many (CASCADE)"
  skills ||--o{ access_logs : "has many"
```

## 4. 缓存架构图

```mermaid
graph TB
  subgraph CompositeCacheProvider
    direction TB
    Get["get(key)"]
    Set["set(key, value, ttl)"]

    subgraph L1["L1 内存缓存"]
      LRU["MemoryLRUCacheProvider<br/>Map&lt;string, {value, expires}&gt;<br/>插入序 = LRU 序"]
      LRUGet["1. 检查 TTL → 过期则删除<br/>2. 命中则删除再插入(移至尾部)<br/>3. 未命中返回 null"]
      LRUSet["1. 超容量时淘汰首条(最久未用)<br/>2. 写入 value + expires"]
    end

    subgraph L2["L2 文件缓存"]
      FileCache["FileCacheProvider<br/>目录: data/cache/"]
      FileGet["1. 读取 .meta 检查 TTL<br/>2. 过期则删除 .cache + .meta<br/>3. 命中则 JSON.parse(.cache)"]
      FileSet["1. 写入 &lt;key&gt;.cache (JSON)<br/>2. 写入 &lt;key&gt;.meta {expires}<br/>3. TTL = L1 TTL × l2TtlMultiplier"]
    end
  end

  Get --> L1
  Get -->|"L1 未命中"| L2
  L2 -->|"L2 命中: 回填 L1"| L1

  Set --> L1
  Set --> L2

  subgraph 缓存键约定
    K1["skill:entry:&lt;slug&gt; — SKILL.md 内容"]
    K2["skill:file:&lt;slug&gt;:&lt;path&gt; — 单文件内容"]
    K3["skill:files:&lt;slug&gt;:&lt;paths&gt; — 批量文件(远程)"]
    K4["skill:filetree:&lt;slug&gt; — 文件树(远程)"]
  end

  style L1 fill:#e8f5e9
  style L2 fill:#e3f2fd
```

## 5. 导入流水线时序图

```mermaid
sequenceDiagram
  actor User
  participant CLI as CLI / REST API
  participant Importer as SkillImporter
  participant Source as LocalSource / GitSource
  participant Validator as validateSkillPackage()
  participant Security as scanForInjection()
  participant Storage as IStorageProvider
  participant SkillRepo as SkillRepository
  participant SkillFileRepo as SkillFileRepository
  participant Cache as CompositeCacheProvider

  User->>CLI: import <source>
  CLI->>Importer: import(source, options)

  rect rgb(245, 245, 245)
    Note over Importer,Source: Step 1-2: 解析源与清单
    alt Git URL
      Importer->>Source: GitSourceResolver.resolve(url)
      Source->>Source: git clone --depth 1 → tmpdir
      Source->>Source: findSkillRoot() → manifest.json
      Source->>Source: parseManifest() + readSkillFiles()
      Source->>Source: rm tmpdir
    else 本地目录
      Importer->>Source: LocalSourceResolver.resolve(dirPath)
      Source->>Source: parseManifest() + validateManifest() + readSkillFiles()
    end
    Source-->>Importer: {manifest, entryContent, skillFiles}
  end

  rect rgb(255, 243, 224)
    Note over Importer,Security: Step 3: 验证技能包
    Importer->>Validator: validateSkillPackage(manifest, entryContent)
    Validator->>Validator: 检查 name 非空且 ≤ 100 字符
    Validator->>Validator: 检查 entry 文件存在且非空
    Validator->>Security: scanForInjection(entryContent)
    Security-->>Validator: ScanResult {safe, issues}
    alt 不安全
      Validator-->>Importer: throw SecurityError
    end
  end

  rect rgb(232, 245, 233)
    Note over Importer: Step 4: 计算内容哈希
    Importer->>Importer: computeContentHash(skillFiles) → SHA-256
  end

  rect rgb(237, 231, 246)
    Note over Importer,SkillRepo: Step 5: 处理重复
    alt options.targetId
      Importer->>SkillRepo: findById(targetId)
      SkillRepo-->>Importer: existing skill
      Importer->>Importer: 验证 name 匹配 + contentHash
    else existing by name
      alt !options.overwrite
        Importer-->>CLI: throw DuplicateSkillNameError
      else contentHash 未变
        Importer-->>CLI: throw ContentUnchangedError
      else 允许覆盖
        Importer->>Importer: 标记为覆盖更新
      end
    else 新技能
      Importer->>Importer: slugify(name) → slug
    end
  end

  rect rgb(227, 242, 253)
    Note over Importer,Storage: Step 6: 写入文件存储
    loop 每个 skillFile
      Importer->>Storage: put(storagePath + file.path, file.buffer)
    end
  end

  rect rgb(255, 249, 196)
    Note over Importer: Step 7: 提取描述
    Importer->>Importer: extractDescription(entryContent) from frontmatter
  end

  rect rgb(220, 237, 200)
    Note over Importer,SkillFileRepo: Step 8-9: 写入数据库
    alt 更新
      Importer->>SkillRepo: update(id, {version++, contentHash, ...})
    else 新建
      Importer->>SkillRepo: create({slug, name, description, ...})
    end
    Importer->>SkillFileRepo: deleteBySkillId(skillId)
    loop 每个 file
      Importer->>SkillFileRepo: create(skillId, {filePath, fileType, fileSize, mimeType})
    end
  end

  rect rgb(255, 235, 238)
    Note over Importer,Cache: Step 10: 清除缓存
    Importer->>Cache: clearByPrefix("skill:entry:<slug>")
    Importer->>Cache: clearByPrefix("skill:file:<slug>")
  end

  Importer-->>CLI: ImportResult {slug, name, version, fileCount, action}
  CLI-->>User: 导入结果
```

## 6. MCP 工具调用时序图

### 6.1 skill_list

```mermaid
sequenceDiagram
  actor Client as MCP 客户端
  participant McpServer as McpServer
  participant Service as SkillService
  participant Provider as ISkillProvider
  participant PermFilter as IPermissionFilter
  participant LogService as AccessLogService
  participant LogRepo as AccessLogRepository

  Client->>McpServer: tool_call: skill_list {}
  McpServer->>Service: listSkillsIndex()

  Service->>Provider: listSkills()
  Provider-->>Service: SkillMeta[]

  Service->>PermFilter: filter(skills)
  PermFilter-->>Service: filtered SkillMeta[]

  Service->>Service: 过滤 published + 按 slug 排序
  Service->>Service: 格式化为 "  - slug: description"

  Service->>LogService: log(action: "list")
  LogService->>LogRepo: create({skillSlug, action: "list"})
  LogRepo-->>LogService: ok

  Service-->>McpServer: 文本内容
  McpServer-->>Client: skill 列表文本
```

### 6.2 skill_view

```mermaid
sequenceDiagram
  actor Client as MCP 客户端
  participant McpServer as McpServer
  participant Service as SkillService
  participant Provider as ISkillProvider
  participant PermFilter as IPermissionFilter
  participant Security as scanForInjection()
  participant Cache as CompositeCacheProvider
  participant LogService as AccessLogService

  Client->>McpServer: tool_call: skill_view {skill_slug}
  McpServer->>Service: viewSkillEntry(slug)

  Service->>Provider: getSkillMeta(slug)
  Provider-->>Service: SkillMeta

  Service->>PermFilter: check(skill.id)
  alt 拒绝
    PermFilter-->>Service: false
    Service-->>McpServer: throw PermissionDeniedError
  end

  Service->>Provider: getSkillEntry(slug)
  Provider->>Cache: get("skill:entry:<slug>")
  alt 缓存命中
    Cache-->>Provider: content
  else 缓存未命中
    Provider->>Provider: storage.get() or HTTP fetch
    Provider->>Cache: set("skill:entry:<slug>", content, 600)
    Cache-->>Provider: ok
  end
  Provider-->>Service: entryContent

  Service->>Security: scanForInjection(content)
  alt 检测到风险
    Security-->>Service: {safe: false, issues}
    Service->>Service: 记录警告(不阻断)
  end

  Service->>Provider: getSkillFileTree(slug)
  Provider-->>Service: fileTree

  Service->>Service: 拼装: 系统头部 + SKILL.md + 可用文件列表提示

  Service->>LogService: log(action: "view_entry", skillSlug)
  LogService-->>Service: ok

  Service-->>McpServer: 增强后文本内容
  McpServer-->>Client: 技能完整内容
```

### 6.3 skill_file

```mermaid
sequenceDiagram
  actor Client as MCP 客户端
  participant McpServer as McpServer
  participant Service as SkillService
  participant Provider as ISkillProvider
  participant PermFilter as IPermissionFilter
  participant Security as validateFilePath()
  participant Cache as CompositeCacheProvider
  participant LogService as AccessLogService

  Client->>McpServer: tool_call: skill_file {skill_slug, file_paths[]}
  McpServer->>Service: readSkillFiles(slug, file_paths)

  Service->>Provider: getSkillMeta(slug)
  Provider-->>Service: SkillMeta

  Service->>PermFilter: check(skill.id)
  alt 拒绝
    PermFilter-->>Service: false
    Service-->>McpServer: throw PermissionDeniedError
  end

  Service->>Provider: getSkillFiles(slug, file_paths)

  alt LocalProvider
    loop 每个 path
      Provider->>Security: validateFilePath(path)
      alt 路径非法
        Security-->>Provider: throw InvalidPathError
      end
      Provider->>Cache: get("skill:file:<slug>:<path>")
      alt 缓存命中
        Cache-->>Provider: content
      else 缓存未命中
        Provider->>Provider: storage.get(storagePath + path)
        Provider->>Cache: set("skill:file:<slug>:<path>", content, 600)
      end
    end
  else RemoteProvider
    Provider->>Security: validateFilePath(path) [逐个校验]
    Provider->>Provider: POST /api/skills/<slug>/files {paths}
    Provider->>Cache: set("skill:files:<slug>:<paths>", result, 600)
  end

  Provider-->>Service: fileContents[]

  Service->>LogService: log(action: "read_files", filePaths)
  LogService-->>Service: ok

  Service-->>McpServer: 文件内容数组(文本或 base64)
  McpServer-->>Client: 请求的文件内容
```

## 7. 配置加载时序图

```mermaid
sequenceDiagram
  participant Main as main()
  participant getConfig as getConfig()
  participant loadConfig as loadConfig()
  participant Env as process.env
  participant FS as 文件系统
  participant Zod as configSchema
  participant Config as AppConfig 单例

  Main->>getConfig: getConfig()
  getConfig->>getConfig: 检查 _config 单例
  alt 已缓存
    getConfig-->>Main: 返回缓存的 config
  else 未缓存
    getConfig->>loadConfig: loadConfig()
  end

  rect rgb(232, 245, 233)
    Note over loadConfig,Env: 步骤 1: 从环境变量构建 envConfig
    loadConfig->>Env: 读取 NODE_ENV, DATABASE_PATH, ...
    Env-->>loadConfig: 环境变量值
    loadConfig->>loadConfig: 构建 envConfig (含默认值)
  end

  rect rgb(227, 242, 253)
    Note over loadConfig,FS: 步骤 2: 合并配置文件
    loadConfig->>Env: SKILL_MCP_CONFIG
    alt 配置文件路径存在
      loadConfig->>FS: 读取 JSON 文件
      FS-->>loadConfig: fileConfig
      loadConfig->>loadConfig: deepMerge(envConfig, fileConfig)<br/>文件配置覆盖环境变量
    end
  end

  rect rgb(255, 243, 224)
    Note over loadConfig,Zod: 步骤 3: Zod 校验
    loadConfig->>Zod: configSchema.parse(mergedConfig)
    alt 校验失败
      Zod-->>loadConfig: throw ZodError
    else 校验通过
      Zod-->>loadConfig: validated AppConfig
    end
  end

  rect rgb(237, 231, 246)
    Note over loadConfig,FS: 步骤 4: 确保目录存在
    loadConfig->>FS: mkdirSync(database dir)
    loadConfig->>FS: mkdirSync(storage dir)
    loadConfig->>FS: mkdirSync(cache dir)
  end

  loadConfig-->>getConfig: AppConfig
  getConfig->>Config: 缓存到 _config 单例
  getConfig-->>Main: AppConfig
```

## 8. 传输层初始化时序图

### 8.1 stdio 模式

```mermaid
sequenceDiagram
  participant Serve as serveAction()
  participant MCP as createMcpServer()
  participant Prompt as buildSkillSystemPrompt()
  participant Registry as registerTools()
  participant Transport as StdioServerTransport

  Serve->>MCP: createMcpServer(skillService, ...)
  MCP->>Prompt: buildSkillSystemPrompt(skills)
  Prompt-->>MCP: instructions 文本
  MCP->>MCP: new McpServer({name, version}, {instructions})
  MCP->>Registry: registerTools(server, skillService)
  Registry->>Registry: server.tool("skill_list", ...)
  Registry->>Registry: server.tool("skill_view", ...)
  Registry->>Registry: server.tool("skill_file", ...)
  MCP-->>Serve: mcpServer

  Serve->>Transport: new StdioServerTransport()
  Serve->>MCP: mcpServer.connect(transport)

  Note over Serve: 服务就绪，通过 stdin/stdout 通信
```

### 8.2 SSE / HTTP 模式

```mermaid
sequenceDiagram
  participant Serve as serveAction()
  participant App as createApp()
  participant HTTP as Node HTTP Server
  participant MCP as createMcpServer()
  participant Transport as Transport Handler

  Serve->>App: createApp(deps, {type})
  App->>HTTP: http.createServer()

  alt Streamable HTTP
    App->>MCP: createMcpServer(skillService, ...)
    App->>Transport: new StreamableHTTPServerTransport()<br/>sessionIdGenerator = UUID
    App->>MCP: mcpServer.connect(transport)
    App->>App: mcpHandler = transport.handleRequest
    Note over App: POST/GET/DELETE /mcp → mcpHandler
  else SSE
    App->>App: sessions = new Map()
    Note over App: GET /mcp/sse → 新建 SSEServerTransport<br/>+ connect 新 McpServer<br/>+ 存入 sessions
    Note over App: POST /mcp/messages →<br/>sessions.get(id).handlePostMessage
  end

  Note over App: /api/* → handleAdminRoute()

  App->>HTTP: httpServer.listen(port, host)
  Note over HTTP: 服务就绪
```

## 9. 安全扫描流程图

```mermaid
flowchart TD
  Start[内容输入] --> Check{enableInjectionScan?}

  Check -->|false| Pass[跳过扫描 → 通过]
  Check -->|true| Scan[scanForInjection content]

  Scan --> P1{匹配: ignore previous instructions?}
  Scan --> P2{匹配: forget everything/all?}
  Scan --> P3{匹配: you are now a/an/free?}
  Scan --> P4{匹配: system: 行尾?}

  P1 -->|是| Unsafe[safe: false, 收集 issue]
  P2 -->|是| Unsafe
  P3 -->|是| Unsafe
  P4 -->|是| Unsafe

  P1 -->|否| Next1[继续]
  P2 -->|否| Next2[继续]
  P3 -->|否| Next3[继续]
  P4 -->|否| Clean[safe: true, issues: empty]

  Unsafe --> Context{调用上下文}
  Clean --> Context

  Context -->|导入时| Reject[throw SecurityError ❌]
  Context -->|查看时| Warn[记录警告, 允许访问 ⚠️]
```

## 10. 权限过滤流程图

```mermaid
flowchart TD
  Start[请求技能列表/详情] --> GetSkills[获取 skills 列表]
  GetSkills --> Filter[IPermissionFilter.filter skills]

  Filter --> Impl{实现类型}

  Impl -->|NoopPermissionFilter| AllowAll[全部放行]

  Impl -->|GroupPermissionFilter| CheckGroups{skill.assignedGroups<br/>是否为空?}

  CheckGroups -->|为空| DefaultCheck{defaultAllow?<br/>或 visibility = public?}
  DefaultCheck -->|是| Allow1[放行 ✓]
  DefaultCheck -->|否| Block1[过滤掉 ✗]

  CheckGroups -->|非空| Intersect{用户 groups ∩<br/>assignedGroups?}
  Intersect -->|有交集| Allow2[放行 ✓]
  Intersect -->|无交集| Block2[过滤掉 ✗]

  AllowAll --> Result[返回过滤后列表]
  Allow1 --> Result
  Allow2 --> Result
  Block1 --> Result
  Block2 --> Result

  Result --> CheckDetail{单技能访问<br/>IPermissionFilter.check?}
  CheckDetail -->|Noop| AllowDetail[允许访问]
  CheckDetail -->|GroupFilter| Note[当前返回 true<br/>TODO: 实现细粒度检查]
```
