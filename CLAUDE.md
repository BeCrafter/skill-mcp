# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm run build          # Compile TypeScript (tsc)
npm run dev            # Watch-mode compilation
npm start              # Run the server (default: stdio transport)
npm run serve          # Alias for `node dist/index.js serve`
npm test               # Run all tests (vitest run)
npm run test:watch     # Tests in watch mode
npm run test:coverage  # Coverage report (v8)
npm run lint           # ESLint on src/
npm run lint:fix       # ESLint with auto-fix
```

Run a single test file:
```bash
npx vitest run tests/unit/utils/security.test.ts
```

Run tests matching a pattern:
```bash
npx vitest run -t "scanForInjection"
```

## Architecture

This is an **MCP (Model Context Protocol) server** that manages reusable skill packages for AI assistants. It exposes three MCP tools (`skill_list`, `skill_view`, `skill_file`) and supports stdio, SSE, and Streamable HTTP transports.

### Layered data flow

```
CLI / MCP Client → SkillService → ISkillProvider → IStorageProvider → filesystem
                                      ↕
                               ICacheProvider (L1 memory LRU + L2 file)
```

**SkillService** (`src/services/skill.service.ts`) is the core business logic layer. It delegates to `ISkillProvider` (which abstracts local vs remote skill access), applies `IPermissionFilter`, runs security scans via `scanForInjection`, and wraps cache lookups.

**ISkillProvider** (`src/provider/interface.ts`) has two implementations: `LocalProvider` (reads from local storage) and `RemoteProvider` (proxies to a gateway/cloud service in gateway deployment mode).

### Key patterns

- **Config singleton** — `getConfig()` in `src/config/index.ts` loads once: env vars first, then deep-merges a JSON config file (path from `SKILL_MCP_CONFIG`). Validated with Zod (`src/config/schema.ts`).
- **Two-layer cache** — `CompositeCacheProvider` chains L1 (memory LRU) → L2 (file-based). L2 TTL is multiplied by `l2TtlMultiplier` (default 2x).
- **Import pipeline** — `SkillImporter` delegates to `LocalSource` or `GitSource` to read files, runs `validateSkillPackage()` (manifest validation + security scan), then persists via repositories. Version bumps are content-hash based.
- **Raw HTTP server** — `src/app.ts` uses Node's `http.createServer` (not Fastify) so MCP SDK transport handlers receive unconsumed request/response streams. Admin REST routes (`/api/*`) are handled inline in the same server.
- **DB** — Drizzle ORM + better-sqlite3. Schema in `src/db/schema.ts`, repositories in `src/db/repositories/`. Migrations via `npm run db:migrate`.

### Config & storage

Config can come from env vars (e.g. `DATABASE_PATH`, `TRANSPORT_TYPE`, `STORAGE_TYPE`) or a `skill-mcp.config.json` file. Storage backends: `local-fs` (default, `./data/skills`) or `aliyun-oss`. All data dirs are auto-created on startup.

### Skill package format

A skill package directory must contain `manifest.json` (with `name`, optional `version`/`entry`/`files`) and an entry file (default `SKILL.md`). Only text-based file extensions are accepted (enforced by `isTextFile()`).

## Code Conventions

- **ESM** — `"type": "module"`, `Node16` module resolution. All local imports use `.js` extensions.
- **TypeScript strict** — `strict: true`, `ES2024` target. No `any` without a lint warning.
- **Tests** — Vitest with globals enabled, `@` alias maps to `src/`. Tests live in `tests/unit/` mirroring `src/` structure.
- **ESLint** — Uses `typescript-eslint` with recommended configs. Ignores `dist/`, `node_modules/`, `tests/`.
- **Node.js >= 22** required.
