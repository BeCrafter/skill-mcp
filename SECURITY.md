# Security Policy

## Supported Versions

| Version | Supported | Security Fix Window |
|---|---|---|
| `0.1.x` (beta) | ✅ | Until v0.2.0 GA + 90 days |
| `< 0.1`         | ❌ | EOL |

The 商用化路线图（[`docs/REVIEWS/2026-05-27-commercialization-review-claude.md`](./docs/REVIEWS/2026-05-27-commercialization-review-claude.md) §16）规定每个 major 版本支持 3 年。

## Reporting a Vulnerability

**Do NOT open a public GitHub Issue for security vulnerabilities.**

Instead:

1. Email **security@becrafter.io** (subject: `[security] <short title>`)
2. Or use [GitHub Private Vulnerability Reporting](https://github.com/BeCrafter/skill-mcp/security/advisories/new)

Include:

- Affected version(s) / commit SHA
- Reproduction steps (minimal PoC preferred)
- Impact assessment (data leak / privilege escalation / DoS / etc.)
- Suggested fix (optional)

## Disclosure Timeline

We follow a **90-day coordinated disclosure** policy:

| Day | Action |
|---|---|
| **0** | Report received, automated acknowledgment within 24h |
| **3** | Triage complete, severity assigned (CVSS v3.1) |
| **7** | Initial mitigation plan shared with reporter |
| **30** | Fix in `dev` branch, internal review |
| **60** | Fix in `main` branch, patch release prepared |
| **90** | Public disclosure (CVE if applicable) + reporter credit |

For **critical** vulnerabilities (CVSS ≥ 9.0), we may compress the timeline to **30-45 days**. Reporters can request extension if more time is needed for upstream fixes.

## Security Audit History

This codebase has been through **19+ rounds / 39 task items** of security hardening (T-501 ~ T-739) covering:

- Path traversal (T-601)
- Prompt injection scanning (`scanForInjection`)
- RBAC + tag-based permission filtering (T-714, T-715)
- SQL/JSON parsing hardening (T-714, T-716)
- Rate / size / cardinality caps (T-702, T-705, T-717, T-725, T-726, T-727)
- Storage path defense-in-depth (T-730)
- Cache key collision (T-729)
- 2-phase storage commit / rollback safety (T-723, T-724)

See [`docs/REFACTORING_BACKLOG.md`](./docs/REFACTORING_BACKLOG.md) for the full audit history.

## Hall of Fame

Researchers who responsibly disclose vulnerabilities will be credited here (with permission).

## Out of Scope

The following are **not** considered security vulnerabilities:

- Self-XSS via `STORAGE_BASE_PATH=$(curl evil.sh)` (operator misconfiguration)
- Stdio mode bypass when `SKILL_MCP_AUTH_TOKEN` is unset (documented opt-in for single-user dev)
- Theoretical timing attacks on bcrypt/sha256 token comparison without amplification
- Vulnerabilities in dependencies that have no fix upstream — we track these via `npm audit` but cannot patch them ourselves
