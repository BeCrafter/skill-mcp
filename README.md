# Skill MCP Server

**Local SQLite Skill Registry with RBAC, BM25 search, and MCP transport.**

A Model Context Protocol (MCP) server that manages reusable skill packages for AI assistants.
Import, version, and serve skill packages through standard MCP tools with built-in security scanning
and role-based access control.

## Features

- **MCP Protocol** — 5 tools: `skill_list`, `skill_search`, `skill_view`, `skill_file`, `skill_feedback`
- **Multi-Transport** — stdio, SSE, and Streamable HTTP transports
- **BM25 Search** — in-memory keyword search over name, description, triggers, `when_to_use`, and
  `embedding_text`. RBAC visibility is applied *before* scoring and limiting.
- **Three-tier RBAC** — Superadmin / Admin / User with role-based tag permissions
- **JWT Authentication** — Admin login via username + password with JWT access/refresh tokens
- **Skill Import** — Import skill packages from local directories or Git repositories (synchronous)
- **Security Scanning** — Built-in prompt injection detection on all imported skill content
- **Versioning** — Automatic semantic versioning with content-hash tracking and rollback support
- **Caching** — Layered memory (LRU) + file-based caching for fast skill retrieval
- **SQLite Storage** — Persistent metadata via Drizzle ORM + better-sqlite3; local-fs for skill files
- **OpenAPI & Swagger** — Built-in API reference at `/api/docs` for HTTP mode deployments
- **Audit Logging** — Automatic tracking of skill mutations with before/after snapshots
- **Prometheus Metrics** — `/metrics` endpoint with import, cache, rate-limit, and permission counters
- **CLI Management** — Full CLI for importing, listing, searching, and managing skills
- **C2 Remote Proxy** — When `CLOUD_SERVICE_URL` is set, the server fronts a remote storage
  Registry via `RemoteSkillProvider`; `skill_search` delegates to the remote's BM25 index.
  Deploy as `--profile c2` via `docker compose`.

## Quick Start

```bash
npx skill-mcp init --username admin --password <password>   # prints a bearer token
npx skill-mcp import ./my-skill/
npx skill-mcp serve --auth-token <token>   # stdio requires auth after init
```

The server starts and accepts MCP connections on stdio. For HTTP mode:

```bash
npx skill-mcp serve --transport http --port 3000
```

Open `http://localhost:3000/api/docs` for the Swagger UI.

## MCP Tools

| Tool | Description |
| --- | --- |
| `skill_list` | List accessible skills (RBAC-filtered) |
| `skill_search` | BM25 keyword search with permission-aware ranking |
| `skill_view` | Get a skill's entry file (SKILL.md) |
| `skill_file` | Read one or more files from a skill |
| `skill_feedback` | Record feedback on a skill's effectiveness |

## CLI Commands Reference

| Command | Description |
| --- | --- |
| `init` | Initialise the data directory and config |
| `serve` | Start the MCP server (default: stdio) |
| `import <source>` | Import a skill from a local dir or Git URL |
| `list` | List installed skills |
| `search --name <name>` | Search skills by name |
| `info <slug>` | Show skill metadata |
| `remove <slug>` | Remove a skill |
| `update <slug>` | Update a skill's metadata |
| `versions <slug>` | List versions of a skill |
| `rollback <slug>` | Roll back to a previous version |
| `sync check [slug]` | Check for remote skill updates |
| `sync pull <slug>` | Pull a remote skill update |
| `lint <source>` | Validate a skill package without importing it |
| `manifest:migrate <dir>` | Migrate a skill directory to the latest manifest schema |
| `user create/list/get/delete/assign-roles/rotate-token` | Manage users |
| `role create/list/get/update/delete` | Manage roles and tag bindings |
| `auth (login/logout/whoami/reset-password)` | Authentication management |

Use `--server-url <url>` to point CLI commands at a remote v0.1 Registry instead of the local DB.

## Environment Variables

See `.env.example` for a complete annotated list.

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_PATH` | SQLite database file path | `~/.skill-mcp/skill-mcp.db` |
| `STORAGE_BASE_PATH` | Skill file storage directory | `~/.skill-mcp/data/skills` |
| `TRANSPORT_TYPE` | MCP transport: `stdio`, `sse`, or `http` | `stdio` |
| `TRANSPORT_PORT` | HTTP/S port | `3000` |
| `CLOUD_SERVICE_URL` | Enable C2 remote-proxy mode (front a remote Registry) | (local mode) |
| `MCP_ONLY_MODE` | Expose only MCP + health endpoints | `false` |
| `API_ONLY_MODE` | Expose only REST API + health | `false` |
| `SKILL_MCP_AUTH_TOKEN` | Bearer token for MCP auth / remote-proxy auth | — |
| `SKILL_MCP_SERVER_URL` | Remote Registry URL for CLI management | (local DB) |
| `AUTH_JWT_SECRET` | JWT signing secret (min 32 chars) | auto-generated |
| `SECURITY_INJECTION_SCAN` | Enable prompt injection detection | `true` |
| `LOG_LEVEL` | Log level: `trace`, `debug`, `info`, `warn`, `error` | `info` |

## Deployment Scenarios

**Scenario A — Local stdio** (personal IDE / agent)
```
TRANSPORT_TYPE=stdio  DATABASE_PATH=./data/skill-mcp.db  STORAGE_BASE_PATH=./data/skills
```

**Scenario C1 — Single HTTP server** (all-in-one)
```
TRANSPORT_TYPE=http  TRANSPORT_PORT=3000
```
`docker compose --profile c1 up -d`

**Scenario C2 — Distributed proxy** (storage + MCP frontends behind Caddy gateway)
```
# Storage (authoritative)
TRANSPORT_TYPE=http  TRANSPORT_PORT=3000  API_ONLY_MODE=true
SKILL_MCP_AUTH_TOKEN=<shared-token>

# MCP node (proxy)
TRANSPORT_TYPE=http  TRANSPORT_PORT=4000  MCP_ONLY_MODE=true
CLOUD_SERVICE_URL=http://storage:3000  SKILL_MCP_AUTH_TOKEN=<shared-token>
```
`docker compose --profile c2 up -d`

## Project Structure

```
src/
├── cli/          CLI commands
├── config/       Configuration loading + schema (zod)
├── cache/        L1 (memory) / L2 (file) cache providers
├── db/           Drizzle schema, migrations, repositories
├── events/       Domain event bus + cache subscriber
├── http/         Handlers, middleware, router, OpenAPI spec
├── import/       Skill importer (local + git sources)
├── mcp/          MCP tools, server, transport, prompts
├── permission/   RBAC tag filter, context builder
├── provider/     ISkillProvider: local + remote implementations
├── retrieval/    BM25 in-memory index
├── services/     SkillService, SkillSearchService, AccessLogService
├── storage/      LocalFileSystemProvider
├── telemetry/    Prometheus metrics
├── types/        Shared TypeScript interfaces
└── utils/        Manifest parsing, security, logging, errors
```

## Development

```bash
npm install
npm run build
npm run lint
npm test
npm run docs:sync
```

Keep `README.md`, `README.zh.md`, and `docs/releases/v0.1.md` aligned with the
v0.1 public surface. Do not commit generated `dist/`, local data, or secrets.

## Documentation

Full docs live under [`docs/`](./docs/README.md) — see the [index](./docs/README.md)
for CLI guide, deployment scenarios, RBAC, and the v0.1 scope contract.

## License

MIT
