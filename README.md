# Skill MCP Server

**Cloud Skill File System & MCP Permission Gateway**

A Model Context Protocol (MCP) server that provides a managed skill file system for AI assistants. Import, version, and serve reusable skill packages through standard MCP tools with built-in security scanning, RBAC, and pipeline orchestration.

## Features

- **MCP Protocol** — Expose skills as MCP tools compatible with any MCP client
- **Multi-Transport** — Supports stdio, SSE, and Streamable HTTP transports
- **Pipeline Engine** — DAG-based skill orchestration with parallel execution
- **RBAC** — Role-Based Access Control with tag-based permissions
- **Skill Feedback** — Collect feedback on skill effectiveness for data-driven improvements
- **Skill Import** — Import skill packages from local directories or Git repositories
- **Security Scanning** — Built-in prompt injection detection on all imported skill content
- **Versioning** — Automatic semantic versioning with content-hash tracking and rollback support
- **Caching** — Layered memory (LRU) + file-based caching for fast skill retrieval
- **SQLite Storage** — Persistent metadata storage via Drizzle ORM + better-sqlite3
- **CLI Management** — Full command-line interface for importing, listing, searching, and managing skills

## 📚 Documentation Navigation

### For Different Roles

**👨‍💻 New Developers**
1. Start with [Quick Start](./docs/QUICK_START.md) (5 minutes)
2. Read [Contributing Guide](./CONTRIBUTING.md) (development process)
3. Check [Claude Code Guide](./CLAUDE.md) (IDE setup)

**🚀 DevOps / Deployment**
- [Production Deployment](./docs/PRODUCTION_DEPLOYMENT.md) — Production setup
- [Scenarios](./docs/SCENARIOS/) — Different deployment modes (A/B/C)

**🏗️ Architects / Maintainers**
- [Architecture Overview](./docs/ARCHITECTURE.md) — System design
- [Organization Rules](./docs/ORGANIZATION.md) — Code structure
- [API Reference](./docs/API_REFERENCE.md) — MCP tools & REST APIs
- [Advanced Topics](./docs/ADVANCED/) — Pipeline engine, RBAC, tech specs

**🧪 QA / Testing**
- [Testing Guide](./docs/TESTING_GUIDE.md) — How to run tests

**📦 Publishing & Release**
- [Publishing Guide](./docs/PUBLISHING.md) — How to publish to npm

**📖 Additional Resources**
- [Code Organization Analysis](./docs.local/CODE_ORGANIZATION_ANALYSIS.md) — Codebase structure analysis

## Prerequisites

- Node.js >= 22.0.0

## Installation

### From npm (recommended)

```bash
# 安装最新稳定版
npm install -g skill-mcp

# 安装特定版本
npm install -g skill-mcp@0.0.1

# 安装预发布版本
npm install -g skill-mcp@next      # 最新预发布版
npm install -g skill-mcp@alpha     # Alpha 测试版
npm install -g skill-mcp@beta      # Beta 测试版
npm install -g skill-mcp@rc        # 候选发布版
```

### From source

```bash
git clone https://github.com/BeCrafter/skill-mcp.git
cd skill-mcp
npm install
npm run build
```

## 📂 Data Storage Location

By default, all skill data, database, and cache files are stored in your user home directory:

```
~/.skill-mcp/
├── data/
│   └── skills/          # Skill packages
├── skill-mcp.db         # SQLite database
└── cache/               # File cache
```

This means **skill-mcp works from any directory** — you can run commands like `skill-mcp list` from any folder and access the same data.

### Customize Storage Location

Override the default paths using environment variables:

```bash
# Custom data directory
export DATABASE_PATH=/custom/path/skill-mcp.db
export STORAGE_BASE_PATH=/custom/path/skills
export CACHE_FILE_DIR=/custom/path/cache

npm start
```

Or set them per-command:

```bash
DATABASE_PATH=/data/prod.db skill-mcp list
```

## 📋 Choose Your Deployment Scenario

This project supports **three flexible deployment modes**:

| Scenario | Transport | Storage | Use Case |
|----------|-----------|---------|----------|
| **A** - Local | stdio | Local | Development, single user |
| **B** - Mixed | stdio | Remote | Local MCP + shared storage |
| **C** - Distributed | HTTP | Local/Remote | Production, multi-client |

👉 **[Quick Start Guide →](./docs/QUICK_START.md)**

- **Scenario A** - [Local Development](./docs/SCENARIOS/SCENARIO_A.md)
- **Scenario B** - [Hybrid Deployment](./docs/SCENARIOS/SCENARIO_B.md)
- **Scenario C** - [Distributed Deployment](./docs/SCENARIOS/SCENARIO_C.md)
- **Full Architecture** - [Complete Reference](./docs/ARCHITECTURE.md)

## Quick Start

### 1. Start the MCP Server

```bash
# Scenario A: Local stdio (recommended for development)
npm start

# Scenario C: HTTP server (production)
TRANSPORT_TYPE=http npm start

# Gateway mode: Proxy to remote cloud service
DEPLOYMENT_MODE=gateway CLOUD_SERVICE_URL=http://cloud-service:3001 npm start
```

### 2. Import a Skill

```bash
# From a local directory
npx skill-mcp import ./path/to/skill-package

# From a Git repository
npx skill-mcp import https://github.com/org/skill-repo --branch main

# With metadata
npx skill-mcp import ./my-skill --category "writing" --tags "prompt,creative"
```

### 3. Manage Skills

```bash
# List all skills
npx skill-mcp list

# View skill details
npx skill-mcp info prompt-writer

# Search skills
npx skill-mcp search --name prompt

# Update metadata
npx skill-mcp update prompt-writer --category "productivity" --display-name "Prompt Writer Pro"

# View version history
npx skill-mcp versions prompt-writer

# Rollback to previous version
npx skill-mcp rollback prompt-writer --to 0.0.1

# Remove a skill
npx skill-mcp remove old-skill --force
```

### 4. Pipeline Orchestration

```bash
# Validate pipeline YAML
npx skill-mcp pipeline validate ./pipeline.yaml

# Visualize pipeline DAG
npx skill-mcp pipeline graph ./pipeline.yaml

# Execute pipeline (dry-run)
npx skill-mcp pipeline run ./pipeline.yaml --input pr_url=https://... --dry-run
```

### 5. RBAC Management

```bash
# Create a role
npx skill-mcp role create --name "data-team" --tags "data,analysis" --description "Data science team"

# Create a user
npx skill-mcp user create --name "Alice" --role-ids "role-uuid-1,role-uuid-2"

# List users
npx skill-mcp user list

# Assign roles
npx skill-mcp user assign-roles user-id-1 --role-ids "role-uuid-1"
```

### 6. Skill Linting

```bash
# Lint a skill package directory
npx skill-mcp lint ./path/to/skill-package
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `skill_list` | List all published skills with optional filtering |
| `skill_view` | View the full entry content of a specific skill |
| `skill_file` | Read individual files from a skill package |
| `skill_pipeline` | Execute a pipeline (DAG orchestration of skills) |
| `skill_feedback` | Submit feedback on skill effectiveness |

## Configuration

Configuration is loaded from environment variables or a `skill-mcp.config.json` file (auto-detected). All fields have sensible defaults:

```jsonc
{
  "app": {
    "name": "skill-mcp",
    "env": "production",           // "development" | "production" | "test"
    "version": "0.0.1"
  },
  "deployment": {
    "mode": "standalone"          // "standalone" | "gateway" | "cloud"
  },
  "gateway": {                   // Only for gateway mode
    "cloudServiceUrl": "http://cloud-service:3001",
    "authToken": "your-token"
  },
  "storage": {
    "type": "local-fs",         // Currently only "local-fs" supported
    "basePath": "./data/skills"
  },
  "database": {
    "path": "./data/skill-mcp.db"
  },
  "cache": {
    "memory": { "enabled": true, "maxSize": 500 },
    "file": { "enabled": true, "cacheDir": "./data/cache" }
  },
  "transport": {
    "type": "stdio",              // "stdio" | "sse" | "http"
    "port": 3000,
    "host": "0.0.0.0",
    "mcpOnlyMode": false         // If true, disables /api/admin/* routes
  },
  "security": {
    "enableInjectionScan": true
  },
  "apiKey": {                    // Optional API key authentication
    "enabled": false,
    "keys": []
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment | `development` |
| `DEPLOYMENT_MODE` | Deployment mode | `standalone` |
| `STORAGE_TYPE` | Storage backend | `local-fs` |
| `STORAGE_BASE_PATH` | Skills directory | `~/.skill-mcp/data/skills` |
| `DATABASE_PATH` | SQLite database path | `~/.skill-mcp/skill-mcp.db` |
| `CACHE_FILE_DIR` | Cache directory | `~/.skill-mcp/cache` |
| `TRANSPORT_TYPE` | Transport type | `stdio` |
| `TRANSPORT_PORT` | HTTP port | `3000` |
| `TRANSPORT_HOST` | HTTP host | `0.0.0.0` |
| `CLOUD_SERVICE_URL` | Cloud service URL (gateway) | - |
| `AUTH_TOKEN` | Auth token (gateway) | - |
| `LOG_LEVEL` | Logging level | `info` |
| `API_KEY_AUTH_ENABLED` | Enable API key auth | `false` |
| `API_KEYS` | Valid API keys (comma-separated) | - |

## Skill Package Format

A skill package is a directory containing:

```
my-skill/
├── manifest.json     # Package metadata (name, version, entry)
├── SKILL.md          # Main skill content (default entry point)
├── references/       # Supporting reference files
│   └── examples.md
└── templates/        # Template files
    └── checklist.md
```

### manifest.json

```json
{
  "name": "my-skill",
  "version": "0.0.1",
  "entry": "SKILL.md",
  "files": ["references/examples.md"]
}
```

## Pipeline Format

A pipeline is a YAML file defining a DAG (Directed Acyclic Graph) of skill stages:

```yaml
name: code-review-pipeline
description: Automated code review with security and style checks

inputs:
  pr_url:
    type: string
    required: true

stages:
  read-pr:
    skill: github-pr-reader
    inputs:
      url: ${{ inputs.pr_url }}
    outputs: [diff, files]

  security-scan:
    skill: security-scanner
    depends_on: [read-pr]
    inputs:
      code: ${{ stages.read-pr.outputs.diff }}
    outputs: [vulnerabilities]

  style-check:
    skill: style-checker
    depends_on: [read-pr]
    inputs:
      files: ${{ stages.read-pr.outputs.files }}
    outputs: [violations]

  generate-report:
    skill: report-writer
    depends_on: [security-scan, style-check]
    inputs:
      security: ${{ stages.security-scan.outputs }}
      style: ${{ stages.style-check.outputs }}
    outputs: [report]

output:
  report: ${{ stages.generate-report.outputs.report }}
```

## Project Structure

```
src/
├── cli/              # CLI commands (import, list, serve, pipeline, user, role, etc.)
├── config/           # Configuration schema and loader
├── mcp/              # MCP server, tools, and transport
│   └── tools/        # MCP tool implementations
├── services/         # Business logic (skill service, access log)
├── provider/         # Data providers (local, remote)
├── pipeline/         # Pipeline engine (DAG, executor, parser)
├── permission/       # Permission filters and RBAC
├── storage/          # Storage providers (local FS)
├── cache/            # Cache providers (memory LRU, file, composite)
├── db/               # Database schema, migrations, repositories
├── import/           # Skill import pipeline (validator, sources)
├── prompt/           # System prompt builder
├── admin/            # Admin API routes
├── http/             # HTTP server and middleware
├── events/           # Event system
├── telemetry/        # Metrics and monitoring
├── middleware/       # Request middleware
├── types/            # TypeScript type definitions
└── utils/            # Shared utilities (security, errors, manifest)
```

## CLI Commands Reference

| Command | Description |
|---------|-------------|
| `serve` | Start MCP server |
| `import <source>` | Import skill from local path or Git repo |
| `list` | List all skills |
| `info <slug>` | Show skill details |
| `search --name <name>` | Search skills by name |
| `update <slug>` | Update skill metadata |
| `remove <slug>` | Remove a skill |
| `versions <slug>` | Show version history |
| `rollback <slug>` | Rollback to previous version |
| `lint <path>` | Lint skill package |
| `pipeline validate` | Validate pipeline YAML |
| `pipeline graph` | Visualize pipeline DAG |
| `pipeline run` | Execute pipeline |
| `user list/create/get/delete/assign-roles` | Manage users |
| `role list/create/get/update/delete` | Manage roles |
| `release:patch` | Bump patch version and create tag |
| `release:minor` | Bump minor version and create tag |
| `release:major` | Bump major version and create tag |
| `release:alpha` | Bump alpha prerelease and create tag |
| `release:beta` | Bump beta prerelease and create tag |
| `release:rc` | Bump RC prerelease and create tag |
| `release:dev` | Bump dev prerelease and create tag |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Watch-mode compilation |
| `npm start` | Run the server |
| `npm test` | Run tests with Vitest |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Generate coverage report |
| `npm run lint` | Lint source files |
| `npm run lint:fix` | Lint and auto-fix |
| `npm run db:migrate` | Run database migrations |
| `npm run docs:sync` | Check README.md sync status |
| `npm run release:patch` | Bump patch version and create tag |
| `npm run release:minor` | Bump minor version and create tag |
| `npm run release:major` | Bump major version and create tag |

## Testing

Tests are written with Vitest and located in `tests/`:

```
tests/
└── unit/
    ├── utils/           # Security scanning, validation, error handling
    ├── cache/           # LRU cache provider
    ├── prompt/          # System prompt generation
    └── import/          # Package validation
```

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

## RBAC Overview

The server implements a flexible RBAC system based on **tags**:

- **Tags**: Capability tags assigned to skills (`skills.tags`)
- **Roles**: Collections of tags that grant access
- **Users**: Platform users assigned to roles

**Permission Rules**:
- `skill.tags = []` → Public skill, accessible to all
- `skill.tags ∩ user.tags ≠ ∅` → Protected skill, accessible if user has matching tag
- `skill.tags ∩ user.tags = ∅` → Restricted skill, not accessible

## Security

- **Prompt Injection Scanning** — All imported skill content is scanned for known injection patterns
- **Path Traversal Protection** — File path validation prevents directory traversal attacks
- **File Type Safety** — Binary files are rejected; only text-based formats are allowed
- **API Key Authentication** — Optional API key-based authentication for admin API routes

## License

MIT
