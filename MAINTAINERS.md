# Maintainers

## Active Maintainers

| Name | GitHub | Areas | Time Zone |
|---|---|---|---|
| Wang Ming | [@kugouming](https://github.com/kugouming) | Architecture, MCP transport, RBAC, storage | UTC+8 |

## Decision Process

We use **lazy consensus** for routine changes and **RFC for breaking changes**.

### Routine changes (most PRs)

- ≥ 1 maintainer approval required
- 72-hour silent window before merge for non-trivial changes
- Bug fixes / docs / single-file refactors can merge immediately after approval

### Breaking changes / new subsystems

Require an **RFC** in `docs/ADVANCED/` before implementation:

1. Open an Issue with the `[RFC]` prefix
2. Discussion period: minimum 7 days
3. Reach consensus (or maintainer override with public reason)
4. RFC merged into `docs/ADVANCED/<topic>.md`
5. Implementation follows the RFC

### What counts as breaking

- New runtime npm dependencies
- Changes to `manifest.json` schema (per `docs/REVIEWS/.../§14.5`)
- Changes to MCP tool semantics (`skill_list` / `skill_view` / `skill_file`)
- Changes to `DEPLOYMENT_MODE` switch behavior
- Database schema changes that require manual migration steps
- HTTP API path renames at `/api/admin/*` or `/api/gateway/*`

## Becoming a Maintainer

We add maintainers based on **sustained contribution + judgment**, not commit count.

Indicators we look for:

- 3+ months of meaningful PR contributions
- Reviews that catch real issues (not just "LGTM")
- Engagement with users in Issues / Discussions
- Domain knowledge in at least one subsystem
- Responsive to security reports and CI failures

## Subsystem Owners

When subsystems grow, we'll add named owners here:

| Subsystem | Owner |
|---|---|
| MCP transport (stdio / SSE / HTTP) | (TBD) |
| Storage (local-fs / aliyun-oss / S3) | (TBD) |
| Pipeline executor | (TBD) |
| RBAC / permissions | (TBD) |
| Database / migrations | (TBD) |
| Cache (memory / file / future Redis) | (TBD) |

## Maintainer Responsibilities

- Review and merge PRs in your area within 7 business days
- Triage Issues weekly
- Respond to security reports within 24h (see [`SECURITY.md`](./SECURITY.md))
- Cut a release every 4-6 weeks (or sooner for critical fixes)
- Keep [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) in sync with code

## Stepping Down

Maintainers can step down at any time by opening an Issue. We thank you for your service and add you to the "Emeritus Maintainers" list below.

## Emeritus Maintainers

(none yet)

## Code of Conduct

This project adopts the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) by reference. Report violations to **conduct@becrafter.io**.
