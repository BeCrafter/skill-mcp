# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Pipeline engine for DAG-based skill orchestration
- RBAC system with tag-based permissions
- Skill feedback mechanism
- User and role management CLI commands
- Version history and rollback support

### Changed
- Improved documentation sync workflow
- Enhanced pre-commit hooks for documentation

### Fixed
- Fixed various bugs and improvements

---

## [1.0.0] - 2026-05-06

### Added
- Initial release of skill-mcp
- MCP protocol support with stdio, SSE, and HTTP transports
- Skill import from local directories and Git repositories
- Security scanning for prompt injection detection
- Two-layer caching (memory LRU + file-based)
- SQLite storage with Drizzle ORM
- CLI management interface
- Multiple deployment modes (standalone, gateway, cloud)
- Admin REST API endpoints