# Skill MCP Server

**Cloud Skill File System & MCP Permission Gateway**

A Model Context Protocol (MCP) server that provides a managed skill file system for AI assistants. Import, version, and serve reusable skill packages through standard MCP tools with built-in security scanning, RBAC, and pipeline orchestration.

## Features

- **MCP Protocol** — Expose skills as MCP tools compatible with any MCP client
- **Multi-Transport** — Supports stdio, SSE, and Streamable HTTP transports
- **Pipeline Engine** — DAG-based skill orchestration with parallel execution
- **Three-tier RBAC** — Superadmin / Admin / User with role-based tag permissions
- **JWT Authentication** — Admin login via username + password with JWT access/refresh tokens
- **CLI Dual Mode** — Local DB direct access or remote HTTP API via `--server-url`
- **Skill Feedback** — Collect feedback on skill effectiveness for data-driven improvements
- **Skill Import** — Import skill packages from local directories or Git repositories
- **Security Scanning** — Built-in prompt injection detection on all imported skill content
- **Versioning** — Automatic semantic versioning with content-hash tracking and rollback support
- **Caching** — Layered memory (LRU) + file-based caching for fast skill retrieval
- **SQLite Storage** — Persistent metadata storage via Drizzle ORM + better-sqlite3
- **CLI Management** — Full command-line interface for importing, listing, searching, and managing skills
- **Self-upgrade Check** — `skill-mcp upgrade` checks npm registry + mirror for newer versions

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
- [CLI Verification Checklist](./docs/CLI_VERIFICATION_CHECKLIST.md) — Full CLI command acceptance checklist

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

### 1. Initialize the System (First Time Only)

```bash
# Initialize with superadmin (JWT secret auto-generated and saved to ~/.skill-mcp/config.json)
npx skill-mcp init --username admin --password YourStrongPassword

# Login to obtain JWT credentials
npx skill-mcp auth login --username admin
```

### 2. Start the MCP Server

```bash
# Scenario A: Local stdio (recommended for development)
npm start

# Scenario C: HTTP server (production)
TRANSPORT_TYPE=http npm start

# Proxy mode: Automatically detected when CLOUD_SERVICE_URL is set
CLOUD_SERVICE_URL=http://cloud-service:3001 npm start
```

### 3. Import a Skill

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

# Create an admin user (with login credentials)
npx skill-mcp user create --name "Alice" --username alice --password Passw0rd --user-type admin --role-ids "role-uuid-1"

# Create a regular user (API token only, no login)
npx skill-mcp user create --name "Bob" --role-ids "role-uuid-1,role-uuid-2"

# List users
npx skill-mcp user list

# Assign roles
npx skill-mcp user assign-roles user-id-1 --role-ids "role-uuid-1"

# Auth management
npx skill-mcp auth whoami
npx skill-mcp auth logout
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
| `skill_search` | Search skills by name, description, or content similarity |
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
    "mcpOnly": false,             // If true, only MCP + health (no Admin/Gateway APIs)
    "apiOnly": false              // If true, only REST + health (no MCP)
  },
  "gateway": {                    // Only when proxying to a remote service
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
    "port": 3000
  },
  "security": {
    "enableInjectionScan": true,
    "hstsEnabled": false
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment | `development` |
| `MCP_ONLY_MODE` | Disable Admin + Gateway APIs (MCP only) | `false` |
| `API_ONLY_MODE` | Disable MCP endpoint (REST only) | `false` |
| `STORAGE_TYPE` | Storage backend | `local-fs` |
| `STORAGE_BASE_PATH` | Skills directory | `~/.skill-mcp/data/skills` |
| `DATABASE_PATH` | SQLite database path | `~/.skill-mcp/skill-mcp.db` |
| `DATABASE_URL` | Database URL (takes precedence over `DATABASE_PATH`) | - |
| `CACHE_MEMORY_ENABLED` | Enable in-memory LRU cache | `true` |
| `CACHE_MEMORY_MAX_SIZE` | Max memory cache entries | `500` |
| `CACHE_FILE_ENABLED` | Enable file-based cache | `true` |
| `CACHE_FILE_DIR` | Cache directory | `~/.skill-mcp/cache` |
| `TRANSPORT_TYPE` | Transport type | `stdio` |
| `TRANSPORT_PORT` | HTTP port | `3000` |
| `CLOUD_SERVICE_URL` | Remote service URL (auto-enables proxy mode) | - |
| `SKILL_MCP_AUTH_TOKEN` | Bearer token for stdio auth + proxy outbound calls | - |
| `AUTH_JWT_SECRET` | JWT signing secret for admin login (min 32 chars, auto-generated by `init`) | - |
| `SKILL_MCP_SERVER_URL` | Remote server URL for CLI remote mode | - |
| `SECURITY_INJECTION_SCAN` | Enable prompt injection detection | `true` |
| `LOG_LEVEL` | Logging level | `info` |
| `OTEL_ENABLED` | Enable OpenTelemetry tracing (`true` / `false`) | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP HTTP endpoint URL; falls back to `ConsoleSpanExporter` when unset | - |
| `OTEL_SERVICE_NAME` | `service.name` resource attribute | `skill-mcp` |
| `OTEL_SERVICE_VERSION` | `service.version` resource attribute | package.json version |

### Stdio Permission Isolation

`stdio` transport has no HTTP headers, so permission isolation is configured by injecting a bearer token at process startup. CLI flag `--auth-token` overrides the env var.

```json
{
  "mcpServers": {
    "skill-mcp": {
      "command": "skill-mcp",
      "args": ["serve"],
      "env": { "SKILL_MCP_AUTH_TOKEN": "sk-live-xxxx" }
    }
  }
}
```

If the database has any active user or tag-protected skill but no token is configured, the server refuses to start to avoid silent anonymous access. Empty databases continue to start anonymously.

### Gateway HTTP Authentication

`/api/gateway/*` is gated by an authentication middleware: every request must include `Authorization: Bearer <token>`. Missing or invalid tokens return `401` before the handler runs. The only anonymous endpoint is `GET /api/health` (kept open for LB and container liveness probes).

```http
401 Unauthorized
Content-Type: application/json

{ "success": false, "error": "Authentication required" }
```

Issue a token by creating a role + user on the server:

```bash
skill-mcp role create --name dev --tags "frontend"
skill-mcp user create --name alice --role-ids <role-id>
# → prints sk-live-xxxx; client sends `Authorization: Bearer sk-live-xxxx`
```

For Proxy → Backend internal calls, create a dedicated `svc-gateway` user on the backend side and configure its token as `SKILL_MCP_AUTH_TOKEN` on the proxy.

`/mcp/*` (SSE / Streamable HTTP) and stdio transports are unaffected — stdio uses the `SKILL_MCP_AUTH_TOKEN` startup-injection path described above.

### JWT Authentication

Admin/superadmin users authenticate via JWT (username + password login). All users also have opaque API tokens for MCP tool access.

```bash
# Initialize system (creates superadmin + default roles, auto-generates JWT secret)
skill-mcp init --username admin --password YourStrongPassword

# Login
skill-mcp auth login --username admin

# Login to remote server
skill-mcp auth login --username admin --server-url http://server:3000

# Change password
# (via API: POST /api/auth/change-password)
```

**JWT Configuration**:
- `AUTH_JWT_SECRET`: Signing secret (min 32 chars). Auto-generated by `init` and saved to `~/.skill-mcp/config.json`
- Access token: 2h lifetime, refresh token: 7d lifetime
- HS256 (HMAC-SHA256) signing algorithm

## Skill Package Format

A skill package is a directory containing:

```
my-skill/
├── SKILL.md          # Main skill content + YAML frontmatter (required)
├── references/       # Supporting reference files
│   └── examples.md
└── templates/        # Template files
    └── checklist.md
```

### SKILL.md frontmatter

The skill's metadata lives in YAML frontmatter at the top of `SKILL.md`:

```yaml
---
manifest_schema: "1.0"   # P1-21 — see "Manifest Schema Versioning" below
name: my-skill
version: 0.0.1
description: Short skill description for the listing API
entry: SKILL.md
files:
  - references/examples.md
tags: [writing, prompt]
category: writing
---

# Skill body in markdown
```

### Manifest Schema Versioning (P1-21)

The optional `manifest_schema` field declares which contract version the
package targets. The current schema is **`1.0`**.

| Client `manifest_schema` | This server (1.x) | Future server (2.x) |
|--------------------------|-------------------|---------------------|
| missing / `0.x`          | ✅ coerced to `1.0` + deprecation warning | ⚠️ may be rejected once 2.x ships |
| `1.0` (any 1.y)          | ✅                | ✅ (back-compat window: 2 minors)   |
| `2.0+`                   | ❌ "server too old, please upgrade" | ✅ |

Migrate existing packages with the bundled CLI:

```bash
# Dry-run a tree (default)
skill-mcp manifest:migrate ./my-skills

# Rewrite SKILL.md in place
skill-mcp manifest:migrate ./my-skills --apply

# Or emit a unified diff for code review / `git apply`
skill-mcp manifest:migrate ./my-skills --patch | git apply
```

> **Legacy `manifest.json`** is deprecated — the importer warns when it sees one, and prefers `SKILL.md` frontmatter. The schema versioning rules above apply identically to either source location.

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
| `init` | Initialize system with superadmin account (first-time setup) |
| `auth login` | Login as admin/superadmin to obtain JWT (supports `--server-url` for remote) |
| `auth logout` | Clear local JWT credentials |
| `auth whoami` | Show current logged-in user info |
| `auth reset-password` | Reset admin password (requires admin+ login, supports remote mode) |
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
| `manifest:migrate <dir>` | Scan & migrate `manifest_schema` (P1-21, supports `--apply` / `--patch`) |
| `migrate:check` | Check migration status |
| `upgrade` | Check for newer version of skill-mcp on npm |
| `pipeline validate` | Validate pipeline YAML |
| `pipeline graph` | Visualize pipeline DAG |
| `pipeline run` | Execute pipeline |
| `eval list` | List eval cases |
| `eval run` | Run eval cases |
| `eval results` | Show eval results |
| `user list/create/get/delete/assign-roles` | Manage users (requires admin+ login, supports remote mode) |
| `user create --username <u> --password <p> --user-type <type>` | Create user with login credentials (admin/superadmin only for --user-type admin) |
| `role list/create/get/update/delete` | Manage roles (requires admin+ login, supports remote mode) |
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

The server implements a two-layer permission system:

### User Types (Operation Permissions)

| Type | Login | Capabilities |
|------|-------|-------------|
| `superadmin` | username + password → JWT | Full control: manage users, roles, skills. Created via `skill-mcp init`. Cannot be modified by other users. |
| `admin` | username + password → JWT | Manage skills, roles, and regular users. Cannot create/modify admin or superadmin users. |
| `user` | API token only (no login) | Browse published skills, use MCP tools, submit feedback. No management operations. |

### Role Tags (Data Visibility)

- **Tags**: Capability tags assigned to skills (`skills.tags`)
- **Roles**: Collections of tags that grant visibility to private skills
- **Users**: Assigned to roles for skill-level access control

**Visibility Rules**:
- `skill.visibility = "public"` → Accessible to all
- `skill.visibility = "private"` + `skill.tags ∩ user.tags ≠ ∅` → Accessible if user has matching tag
- `skill.visibility = "private"` + `skill.tags ∩ user.tags = ∅` → Not accessible

> **User type** controls **what you can do** (operation permissions). **Role tags** control **what you can see** (data visibility). These are independent layers.

## CLI Remote Mode

All management commands support remote operation via `--server-url` or `SKILL_MCP_SERVER_URL`:

```bash
# Remote mode via environment variable
export SKILL_MCP_SERVER_URL=http://server:3000
skill-mcp user list    # calls HTTP API
skill-mcp role create --name dev --tags "backend"

# Remote mode via command-line flag
skill-mcp user list --server-url http://server:3000

# Local mode (default, direct DB access)
skill-mcp user list    # reads local database directly
```

**Login requirements**: `user *`, `role *`, `import`, `remove`, `update`, `rollback` commands require admin+ login. `list`, `info`, `search`, `serve`, `pipeline`, `lint` are login-free.

## Security

- **Prompt Injection Scanning** — All imported skill content is scanned for known injection patterns
- **Path Traversal Protection** — File path validation prevents directory traversal attacks
- **File Type Safety** — Binary files are rejected; only text-based formats are allowed
- **Per-user RBAC** — Admin/superadmin users authenticate via JWT (username + password login); regular users authenticate with API bearer tokens issued by `skill-mcp user create`. User type (`superadmin`/`admin`/`user`) determines operation permissions; role tags determine skill visibility. For service accounts, reuse the user table with a `svc-*` naming convention.

## License

MIT
