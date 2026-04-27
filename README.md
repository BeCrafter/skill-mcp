# Skill MCP Server

**Cloud Skill File System & MCP Permission Gateway**

A Model Context Protocol (MCP) server that provides a managed skill file system for AI assistants. Import, version, and serve reusable skill packages through standard MCP tools with built-in security scanning and permission controls.

## Features

- **MCP Protocol** — Expose skills as MCP tools (`skill_list`, `skill_view`, `skill_file`) compatible with any MCP client
- **Multi-Transport** — Supports stdio, SSE, and Streamable HTTP transports
- **Skill Import** — Import skill packages from local directories or Git repositories
- **Security Scanning** — Built-in prompt injection detection on all imported skill content
- **Versioning** — Automatic semantic versioning with content-hash tracking
- **Caching** — Layered memory (LRU) + file-based caching for fast skill retrieval
- **SQLite Storage** — Persistent metadata storage via Drizzle ORM + better-sqlite3
- **CLI Management** — Full command-line interface for importing, listing, searching, and managing skills
- **Flexible Storage Backends** — Local filesystem or Aliyun OSS for skill file storage

## Prerequisites

- Node.js >= 22.0.0

## Installation

```bash
npm install
npm run build
```

## Quick Start

### 1. Start the MCP Server

```bash
# stdio transport (default, for MCP clients)
npm run serve

# SSE transport
npm run serve -- --transport sse --port 3000

# Streamable HTTP transport
npm run serve -- --transport http --port 3000
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

# Remove a skill
npx skill-mcp remove old-skill --force
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `skill_list` | List all published skills with optional filtering |
| `skill_view` | View the full entry content of a specific skill |
| `skill_file` | Read individual files from a skill package |

## Configuration

Configuration is loaded from environment variables or a `skill-mcp.config.json` file (auto-detected). All fields have sensible defaults:

```jsonc
{
  "app": {
    "name": "skill-mcp-server",
    "env": "production"           // "development" | "production" | "test"
  },
  "deployment": {
    "mode": "standalone"          // "standalone" | "gateway"
  },
  "storage": {
    "type": "local-fs",           // "local-fs" | "aliyun-oss"
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
    "host": "0.0.0.0"
  },
  "security": {
    "enableInjectionScan": true
  }
}
```

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
  "version": "1.0.0",
  "entry": "SKILL.md",
  "files": ["references/examples.md"]
}
```

## Project Structure

```
src/
├── cli/              # CLI commands (import, list, serve, etc.)
├── config/           # Configuration schema and loader
├── mcp/              # MCP server, tools, and transport
├── services/         # Business logic (skill service, access log)
├── storage/          # Storage providers (local FS, OSS)
├── cache/            # Cache providers (memory LRU, file, composite)
├── db/               # Database schema, migrations, repositories
├── import/           # Skill import pipeline (validator, sources)
├── prompt/           # System prompt builder
├── permission/       # Permission filter interface
├── admin/            # Admin API routes
├── types/            # TypeScript type definitions
└── utils/            # Shared utilities (security, errors, manifest)
```

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

## Security

- **Prompt Injection Scanning** — All imported skill content is scanned for known injection patterns (e.g., "ignore previous instructions", "forget everything", "you are now")
- **Path Traversal Protection** — File path validation prevents directory traversal attacks
- **File Type Safety** — Binary files are rejected; only text-based formats are allowed

## License

MIT
