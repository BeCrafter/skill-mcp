# Release Notes

This file mirrors `CHANGELOG.md` but is written for end users (skill authors,
operators, customers) — the wording explains **what action you should take**,
not just what changed in the codebase.

> **Schema-change discipline (review §14.5.5):** Every change to the manifest
> schema contract must appear in **both** `CHANGELOG.md` and `RELEASE_NOTES.md`.
> If you propose a schema bump in a PR, both files must update in the same
> commit — see `docs/ARCHITECTURE.md` §11.6 for the full procedure.

---

## Unreleased

### OIDC operator README — stage 4 (P1-14, partial)

`README.md` and `README.zh.md` now carry a complete operator-facing
**OIDC / SSO** chapter after the **Gateway HTTP Authentication** section.
This is the documentation deliverable from P1-14 stage 4. Six subsections
walk an operator from "I want to plug in Auth0 / Keycloak / Okta" to "my
SSO users have role tags on the request context":

1. **Configure your IdP** — what `iss` / `aud` / `sub` / `groups` claims
   the server expects, signing-algorithm whitelist (`RS256` default;
   `RS384` / `RS512` opt-in; `HS*` + `alg=none` unconditionally rejected).
2. **Wire the server config** — the three required env vars
   (`OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_JWKS_URI`) plus the optional
   fine-tuning knobs (`OIDC_USER_CLAIM` / `OIDC_GROUPS_CLAIM` /
   `OIDC_CLOCK_SKEW_SEC` / `OIDC_JWKS_TTL_MS` / `OIDC_ALLOWED_ALGORITHMS`).
   Omitting any of the three keeps OIDC fully disabled — back-compatible.
3. **First-login auto-provisioning** — what gets created on first sight
   (`users` row + `oidc_identities` join row), why the sentinel token
   format prevents collisions with real bearer credentials.
4. **Map IdP groups to roles** — five `curl` examples covering list,
   create, atomic replace (PUT), delete, and identity audit. Explains
   the **additive merge** semantics: SSO never strips manual `user-role-cmd
   grant`; mapping removal is required for revokes to stick.
5. **Tag resolution** — `RequestContext.tags` is the **union** of DB
   role tags and JWT group-claim strings. Documents the break-glass
   path where an IdP issuing `groups: ["admin:write"]` literally grants
   admin-write without any DB rows.
6. **Failure modes** — why every JWT failure returns uniform 401 (defeats
   oracle attacks), why a JWT-shaped failure doesn't fall through to the
   opaque-token sha256 lookup, and what happens when the provisioner
   itself fails (graceful degrade to synthetic context — token
   verification already passed, so the request still succeeds).

**Action required:** none — this is documentation only. If you have been
holding off on enabling OIDC because you wanted a complete operator
runbook, that runbook now exists in both `README.md` and `README.zh.md`.

**Stage 4 integration tests still deferred.** A follow-up PR will add
integration tests against a real OIDC mock IdP (testcontainers
Keycloak / dex) — not blocking the P1-14 primary delivery.

---

### OIDC user auto-provisioning + group→role mapping + admin REST — stage 3 (P1-14)

Stage 2 verified JWTs and built a synthetic request context, but it never
persisted the SSO identity — every login produced a fresh
`userId = "oidc:<iss>:<sub>"` placeholder that could not be referenced by
audit logs, role grants, or any other DB-anchored feature. **Stage 3 is
the bridge that turns SSO from "the gateway accepts your token" into "you
are a first-class user."** The first verified token from a new
`(issuer, subject)` pair now creates a real user row, an
`oidc_identities` join row, and (if your IdP issues a `groups` claim)
seeds your role grants from a tenant-scoped group→role mapping table.
Every subsequent request from the same SSO identity resolves to that
same `userId` — your admin audit log finally shows real user identities
instead of synthetic placeholders.

**What changed:**

- Two new tables: `oidc_identities` joins one user to one
  `(issuer, subject)` pair (UNIQUE globally — an SSO subject cannot be
  duped across tenants), and `oidc_group_role_map` stores tenant-scoped
  `(group_name → role_id)` rules so the same `engineering` group can
  grant different roles in different tenants.
- A new `OidcProvisioner` lives between the verifier and the request
  context. On every verified JWT it: (a) finds-or-creates the
  `oidc_identities` row, (b) finds-or-creates the user row (with a
  randomized sentinel token so the row satisfies the `users.token NOT
  NULL UNIQUE` constraint without colliding with real bearer tokens),
  (c) touches `last_seen_at` for audit, (d) reads the JWT's `groups`
  claim, (e) **additively** merges role grants from
  `oidc_group_role_map` into `user_roles` — your manual `user-role grant`
  changes are preserved across SSO logins.
- `RequestContext.userId` is now a real UUID for any user who has logged
  in via SSO at least once. The synthetic `oidc:<iss>:<sub>` namespace
  remains as the fallback if the provisioner returns null or throws —
  a transient DB blip on a write must not invalidate an otherwise-valid
  token.
- Tags on the resolved context are the **union** of (a) tags aggregated
  from your DB role grants and (b) tags derived from the JWT's `groups`
  claim. If your IdP carries `groups: ["engineering"]` and your tenant
  has `engineering → r-fe (tags: ["fe","js"])`, you see all three tags.
- Five new admin REST endpoints under `/api/admin/oidc/*` for managing
  the mapping (list / create / replace / delete) plus a read-only
  identities audit. Operators can pre-seed mappings before flipping
  SSO on — the admin routes register unconditionally; the provisioner
  itself only constructs when `auth.oidc` is configured.

**Action required:**

- **You operate SSO.** Audit your existing `groups` claim values, then
  land matching mappings via `POST /api/admin/oidc/groups-mapping`
  *before* upgrading. Without mappings, group claims still flow through
  as raw tags (stage-2 behavior); with mappings, they additionally
  grant roles whose tags are persisted in `user_roles`.
- **You scripted user creation.** SSO users now appear in the `users`
  table with a sentinel token of the form
  `sha256("oidc-sentinel:" + random)`. Don't try to log in with that
  token — it is intentionally not a usable bearer credential. Use
  `oidc_identities` to find SSO users for audit / management.
- **You manually grant roles to SSO users.** The provisioner is
  additive — it adds roles from group mappings on every visit, but
  never removes roles that are not in the mapping. Manual grants via
  `user-role-cmd grant` survive across logins. Manual revokes via
  `user-role-cmd revoke` will be re-granted on the next login if the
  group mapping still names that role; remove the mapping if you want
  the revoke to stick.
- **You rely on the synthetic `oidc:<iss>:<sub>` userId in audit logs.**
  Existing audit rows are unchanged, but new rows for previously-seen
  SSO identities will use the real UUID. If you have downstream tooling
  that parses the synthetic namespace, update it to join through
  `oidc_identities.user_id` instead.

**Stage 4 still deferred.** Stage 4 will add operator README sections
covering IdP audience / claims setup and admin REST configuration, plus
integration tests against a real OIDC mock IdP (testcontainers
Keycloak / dex). Until then, configure mappings via the admin REST
endpoints documented in `docs/ARCHITECTURE.md` §12 batch 43.

---

### OIDC bearer-token middleware wiring — stage 2 (P1-14)

Stage 1 shipped the verifier primitive but did **not** wire it into the
request path. Stage 2 closes that gap: configuring OIDC now actually
enables SSO. JWT-shaped bearer tokens are verified end-to-end across
the MCP context-builder, the `/api/gateway/*` middleware, the
`/api/admin/*` middleware, and the stdio fallback path — all four
layers share a single `OidcVerifier` and a single JWKS cache so a
multi-tenant deployment makes one upstream JWKS fetch per TTL window,
not one per layer.

**What changed:**

- A bearer token matching `^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`
  (three base64url segments) is treated as an OIDC JWT and routed to
  `verifier.verify()`. Anything else — opaque tokens issued via
  `skill-mcp user create`, including legacy callers — flows through the
  existing sha256 lookup unchanged.
- A successfully verified JWT synthesises a request context with
  `userId = "oidc:<issuer>:<subject>"`, `tenantId = default`,
  `tags = <groups claim filtered to non-empty strings>`, and
  `isAuthenticated = true`. The synthetic `oidc:` namespace is
  deliberate — it cannot collide with native UUIDs in the users table
  while stage 3 prepares the auto-provisioning bridge.
- A JWT that **fails** verification does **not** fall through to the
  opaque sha256 lookup. It collapses to anonymous and the request is
  rejected at the middleware (401 / 403). An expired Auth0 token is a
  real authentication failure; pretending it might be an opaque token
  would leak timing information and confuse operators debugging "why
  did my expired token work for one second longer".
- Group → tag passthrough is the default for stage 2. If your IdP
  issues `{"groups": ["admin:write", "ops"]}`, the user immediately
  has those tags on the resolved request context and can hit the
  admin REST surface without provisioning a DB user. Stage 3 will
  layer a configurable group → role mapping table on top; until then,
  carry the tags you want directly in the claim.

**Action required:**

- **You set `OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_JWKS_URI` in stage 1
  expecting it to be a no-op.** With this release, those variables now
  actively enforce. Verify your config matches your IdP before
  upgrading: a typo in `OIDC_AUDIENCE` will start returning 401 to
  every JWT-bearing request. Setting only one or two of the three keeps
  stage-2 enforcement disabled (the zod block requires all three to
  activate).
- **You rely on opaque tokens that happen to look JWT-shaped.** Vanishingly
  unlikely (opaque tokens issued by `skill-mcp user create` are 32-byte
  hex strings — no dots), but if you have such a token from a custom
  provisioning script, regenerate it before upgrading.
- **You operate an admin path with OIDC.** Make sure the group claim
  you want to admit carries the literal tag `admin:write`. The admin
  middleware checks `tags.has("admin:write")` against the synthetic
  context the same way it checks against an opaque-token user's
  aggregated role tags.

**Stages 3 and 4 still deferred.** Stage 3 will add user
auto-provisioning (one row per `(issuer, subject)`) plus an admin REST
endpoint to manage group → role mapping. Stage 4 will add the operator
README sections and integration tests against a real OIDC mock.

---

### OIDC JWT verifier primitive — stage 1 (P1-14)

The first slice of SSO support has landed: a low-level OIDC JWT verifier
primitive plus a JWKS provider with TTL cache and key-rotation handling.
**Stage 1 ships verification machinery only — it does not yet wire OIDC
into the bearer-token middleware.** Existing opaque-token authentication
keeps working unchanged; nothing in this release changes the request
path. Stages 2/3/4 (middleware wiring → user auto-provision + group→role
mapping → admin REST + docs) follow in subsequent releases.

**What you can do now:**

- Embed `OidcVerifier` directly in your own code if you are extending
  skill-mcp. Construct one with `{ issuer, audience, jwks }` (and
  optionally `allowedAlgorithms`, `clockSkewSec`, `now`); call
  `await verifier.verify(token)` to get back `{ header, payload,
  signature, raw }` or catch a `JwtVerificationError` whose `reason` is
  one of nine documented values (`malformed`, `expired`,
  `not_yet_valid`, `invalid_signature`, `issuer_mismatch`,
  `audience_mismatch`, `key_not_found`, `unsupported_algorithm`,
  `jwks_fetch_failed`).
- Configure OIDC ahead of time. Setting `OIDC_ISSUER` /
  `OIDC_AUDIENCE` / `OIDC_JWKS_URI` (the three required fields) is
  safe today — the optional `auth.oidc` config block is read but no
  middleware consumes it yet, so you can land your operator config
  before stage 2 enables enforcement.

**Design choices you should know about:**

- **Zero new dependencies.** Verification uses Node 22's built-in
  `crypto.createPublicKey({format:"jwk"})` + `crypto.verify()`. We did
  *not* add `jose`, `jsonwebtoken`, or `jwks-rsa` — the supply-chain
  attack surface for SSO stays at zero.
- **Uniform 401 responses.** All nine `JwtVerificationError` reasons
  carry HTTP status 401. An attacker probing the gateway cannot tell
  whether they failed signature verification, audience match, or
  expiry — every failure looks identical to the network.
- **Algorithms.** `RS256` by default; `RS384` and `RS512` are opt-in
  via `OIDC_ALLOWED_ALGORITHMS=RS256,RS512`. `HS*` (symmetric) and
  `alg=none` are unconditionally rejected — neither has a place in an
  OIDC trust model.
- **Audience matching.** Both the configured audience and the token's
  `aud` claim may be a string or an array of strings; verification
  passes when the intersection is non-empty. This matches the way
  Auth0 / Okta often issue tokens carrying both your API identifier
  and the app's `client_id`.
- **JWKS caching with rotation.** `RemoteJwksProvider` caches the
  document for 10 minutes (configurable via `OIDC_JWKS_TTL_MS`). On a
  `kid` cache miss it refreshes once — this is how mid-validity key
  rotation is handled. A second miss after the refresh raises
  `key_not_found` rather than spinning. Concurrent verify calls share
  a single in-flight refresh promise, so a thundering herd at TTL
  expiry costs you exactly one fetch.

**Settings reference (for operators preparing for stage 2):**

| Env var | Default | Notes |
|---------|---------|-------|
| `OIDC_ISSUER` | — | Required to enable OIDC. Strict equality with `iss` claim. |
| `OIDC_AUDIENCE` | — | Required. Comma-separated for multi-audience setups. |
| `OIDC_JWKS_URI` | — | Required. Provider's JWKS endpoint. |
| `OIDC_USER_CLAIM` | `sub` | Which claim becomes the user identity. |
| `OIDC_GROUPS_CLAIM` | `groups` | Which claim becomes the group list (used in stage 3). |
| `OIDC_CLOCK_SKEW_SEC` | `60` | Tolerance applied to both `exp` and `nbf`. |
| `OIDC_JWKS_TTL_MS` | `600000` | JWKS cache TTL (10 min). |
| `OIDC_ALLOWED_ALGORITHMS` | `RS256` | Comma-separated. `HS*` / `none` are always refused. |

**Action required:** None. SSO is opt-in and stage 1 ships only the
primitive — your existing token-based authentication is unchanged.

---

### Skill eval framework — stage 3 (P1-12)

Stage 2 shipped `skill-mcp eval run <slug>` so you can persist run rows
tagged with the skill's current version. **Stage 3 turns those rows into a
publish-time gate**: a skill cannot transition into the `published` state
unless every case has a `pass` row for the version on disk. This closes the
loop the review doc called out — eval cases that exist but never run, or
fail silently, can no longer ride into a published version.

**What changed:**

- `POST /api/admin/skills/:slug/publish` now refuses with HTTP 409
  `{success: false, code: "EVAL_REGRESSION_GATE", error: "..."}` when at
  least one persisted case is failing or untested for `skill.version`. The
  error body lists `failingCases` and `untestedCases` so you can fix or
  re-run the right ones — no need to query the runs table by hand.
- The same gate runs on **republish** (deprecated → published). Deprecate
  and archive transitions are unaffected — the gate is exclusively about
  going *into* published.
- `error`-status runs (provider crash) are treated as **untested**. A
  crash leaves us with no signal about case behaviour, so we surface it
  alongside the never-ran cases rather than letting it count as "tested
  and passed".
- Skills with **zero persisted cases** pass the gate trivially. Eval is
  opt-in — adding `eval_cases:` is the user's explicit choice, not the
  platform's mandate. If you want to publish a skill without an eval
  suite, leave `eval_cases:` out of `SKILL.md`.

**Bypass for emergencies:**

`POST /api/admin/skills/:slug/publish?force=true` skips the gate. The
admin still gets an audit-grade `forced: true` line in the structured
log, and the underlying runs table is untouched — the next regular
`skill-mcp eval run <slug>` will write fresh rows that the next publish
attempt will re-evaluate. Only literal `?force=true` matches; `force=1`
or `force=yes` still gate. Republish accepts the same flag.

**Operator workflow once stage 3 is live:**

```bash
skill-mcp import ./my-skill           # writes new SKILL.md with eval_cases
skill-mcp eval run my-skill           # appends pass/fail rows to skill_eval_runs
                                      # (process exits 1 if any case failed)
curl -X POST .../api/admin/skills/my-skill/publish   # 200 if all-pass, 409 otherwise
```

**Migration impact:** none. The gate only activates when a skill has
`eval_cases:` defined AND `evalRepo` is wired into the running process
(this is the `serve` default; CLI tools that don't construct an
`evalRepo` continue to publish without gating). Existing skills without
eval cases keep publishing exactly as before.

---

### Skill eval framework — stage 2 (P1-12)

Stage 1 shipped the `eval_cases:` manifest contract. Stage 2 ships **DB
persistence + a minimal runner CLI** so you can actually run those cases and
see pass/fail rows. The runner uses a degenerate echo provider for now
(input → output passthrough); stage 3 wires real LLMs and the version-bump
regression gate.

**What you can do today:**

- Re-import any skill with `eval_cases:` in its `SKILL.md` — cases now land in
  the new `skill_eval_cases` table. No source changes required; the importer
  picks them up automatically.
- `skill-mcp eval list <slug>` — print every persisted case with its
  expectations. Useful as a smoke-test that import wired through.
- `skill-mcp eval run <slug>` — execute every case via the echo provider,
  persist one row per case to `skill_eval_runs`, and print a coloured
  pass/fail/error breakdown. Process exits with code 1 if any case
  failed/errored — this is the CI gate idiom:
  ```bash
  skill-mcp eval run my-skill && deploy.sh
  ```
- `skill-mcp eval results <slug> [--limit N]` — show the most recent N runs
  (default 20), newest first.

**What `eval run` actually checks (stage-2 echo provider):**

The echo provider just returns `output = input` and `toolsUsed = []`. So:

- A case with only `expected_output_contains: ["foo"]` and `input: "say foo"`
  will **pass** (the echo provider's output contains "foo").
- A case with `expected_tools: ["search"]` will **fail** with
  `expected_tools missing: search` (the echo provider doesn't call any tools).

That is intentional — stage 2 is here to prove the assertion + persistence
machinery end-to-end. Stage 3 swaps in real LLMs without changing the runner
contract.

**Assertion semantics (refined this stage):**

- `expected_tools` — **all** of these tools must appear in the provider's
  `toolsUsed` list. Extras are allowed.
- `expected_output_contains` — **all** of these substrings must appear in the
  output. Order doesn't matter.
- `expected_output_not_contains` — **none** of these substrings may appear.
- Any one check failing yields `status="fail"` and the first failure is
  surfaced in the `failure_reason` column.
- Provider exception → `status="error"` with the exception message; the
  runner continues to the next case so a single bad case can't mask others.

**What still doesn't work yet:**

- The runner uses an echo provider only. There is no real-LLM provider
  registered yet — `skill-mcp eval run` cannot exercise actual agent
  behaviour. Stage 3 ships pluggable providers (`--provider <name>`).
- No version-bump regression gate. `skill-mcp import --version-bump` still
  doesn't refuse to publish when previously-passing cases regress on the new
  version. Stage 3 wires the gate via `findLatestRunStatusByCase` (already
  built into the repo, ready to be consumed).
- No HTTP REST endpoint for the runner — only the CLI. A REST surface is
  on the stage-3 backlog.
- No A/B grayscale — same-skill version comparison via tag-based routing is
  still deferred (review item 1.4 third bullet).

**Operators:** the new tables are created automatically on next process
start (drizzle migrator). No manual `db:migrate` invocation required, but
the same PR fixes a stage-2b regression where `0014_skill_embeddings.sql`
shipped on disk but was never registered in the migrator's journal — the
embeddings sidecar table was being silently skipped on every fresh DB.
This is now corrected; existing dev DBs aren't affected (the table was
already present from earlier hand-creation), but production / CI DBs that
re-bootstrap from `migrate.ts` will now pick it up.

---

### Skill eval framework — stage 1 (P1-12)

A new `eval_cases:` field is now accepted in `SKILL.md` frontmatter. Stage 1
only persists the contract — there is **no runner yet**, no DB row, no
version-bump gate. What you do today is author cases that future stages will
auto-execute when you bump a skill version.

**What you can do today:**

- Declare cases under `eval_cases:` in your `SKILL.md` frontmatter:
  ```yaml
  eval_cases:
    - name: "basic-search"
      input: "find the regex pattern in src/"
      expected_tools: ["search"]
      expected_output_contains: ["matched"]
      expected_output_not_contains: ["error"]
  ```
- Each case must declare at least one of `expected_tools` /
  `expected_output_contains` / `expected_output_not_contains` — a case
  without expectations cannot fail and is rejected at import time.
- `skill-mcp lint <dir>` now reports `✓ eval_cases: N case(s)` when present
  and an `ℹ no eval_cases declared — version-bump regression will skip this
  skill` info nudge when absent (does not fail lint).

**What's enforced:**

- Caps: ≤ 32 cases, name ≤ 128 chars, input ≤ 4096 chars, ≤ 16 expectations
  per list × ≤ 1024 chars each.
- Case names must be unique within a skill (so result rows can key by name in
  stage 2).
- Both snake_case (`expected_tools`) and camelCase (`expectedTools`) per-case
  keys are accepted; the importer normalizes to camelCase before validation.

**What still doesn't work yet:**

- No DB persistence — cases pass through validation but are not stored on the
  skill row. Stage 2 adds the `skill_eval_cases` / `skill_eval_runs` tables.
- No runner — there is no command that actually executes a case against an
  agent and compares the output. Stage 2 ships the runner CLI / REST entrypoint.
- No version-bump gate — `skill-mcp import --version-bump` does not yet refuse
  to publish when eval cases regress. Stage 3 wires the gate.
- No A/B grayscale — same-skill version comparison via tag-based routing is
  deferred (review item 1.4 third bullet).

If you author cases now, they survive future re-imports unchanged and become
auto-runnable the moment stage 2 ships.

---

### Embedding retrieval PoC — stage 3 (P1-11)

Semantic / vector search lands. Stage 2b's BM25 keyword index gets a cosine-similarity
sibling, plus a hybrid combiner that blends both signals. **The OSS distribution
keeps stage-2b behaviour out of the box** — stage 3 is a no-op until an operator
wires in a real embedding provider. Existing clients see zero behavior change.

**What you can do today:**

- Pass `mode: "vector"` or `mode: "hybrid"` to the `skill_search` MCP tool.
  Without an embedding provider configured, both modes silently fall back to
  BM25 — same response shape, no feature-flag dance on the client.
- Tune the hybrid blend with `hybridAlpha` ∈ [0, 1]. `1.0` = BM25 only, `0.0` =
  vector only, `0.5` (default) treats them equally. Out-of-range values are
  clamped (typo > throw).
- When a real `IEmbeddingProvider` is wired in (e.g. an OpenAI / local model
  adapter), stage-3 turns on automatically: `searchAsync()` embeds the query,
  the in-memory `VectorIndex` ranks by cosine similarity, and `combineHybrid`
  merges the two lists by per-list min-max normalization so unbounded BM25
  doesn't drown out [-1, 1] cosine.

**What's wired but not yet user-visible:**

- `IEmbeddingProvider` interface + two reference impls (`NullEmbeddingProvider`
  default, `HashEmbeddingProvider` deterministic FNV-1a stub for tests / local
  dev). Real providers (OpenAI, local sentence-transformers, etc.) ship as
  separate adapters in subsequent releases.
- `skill_embeddings` sidecar table (drizzle migration 0014) — one row per
  skill, FK CASCADE so deleting a skill drops its vector. Embeddings live off
  the hot `skills` row to keep `SELECT *` cheap.
- LLM-cost guard: re-embedding only fires when `content_hash` changes, so a
  cosmetic update (tag tweak, visibility flip) doesn't burn an API call.
- Model-swap path: when an operator changes the configured provider, stale
  `model_name` rows are ignored at hydration and refilled lazily by the next
  mutation; `deleteWhereModelNot()` is available for an admin-triggered purge.

**What still doesn't work yet:**

- No bundled real embedding provider — operators must implement
  `IEmbeddingProvider` themselves until upstream OpenAI / local adapters land.
- `vectorIndex` is in-memory; for >100k skills the 1.5–6 KiB-per-row footprint
  starts to matter. A pgvector-backed swap is on the stage-4 roadmap.
- No admin REST endpoint yet for "rebuild all embeddings against current
  model" — workaround is to restart the process after a provider swap.

### Embedding retrieval PoC — stage 2b (P1-11)

The `skill_search` MCP tool is **live**. Agents can now ask the server "find me
skills that match this query" and get a ranked list back, instead of scanning
every skill description by hand. The retrieval signals you wrote in stage 1
(`triggers`, `when_to_use`, `embedding_text`) and persisted in stage 2a are
finally read.

**What you can do today:**

- Call the new MCP tool `skill_search` with `{query, limit?, tags?}`. Results
  come back sorted by BM25 score with three-decimal precision:
  ```
  - ripgrep-helper [id:abc123] (score=5.123): Search a directory tree for...
  - grep-wrapper   [id:def456] (score=2.870): Wrap GNU grep with smart...
  ```
  Empty results emit `No matching skills found for "<query>"` instead of an
  empty list, so the agent knows to fall back to listing.
- Pass `query=...` to the existing `skill_list` tool to get the same ranked
  ordering inline with the regular index.
- Edit retrieval signals on already-imported skills via the new admin REST
  endpoint `PUT /api/admin/skills/:slug/retrieval`. Body accepts both
  snake_case (`when_to_use`, `embedding_text`) and camelCase (`whenToUse`,
  `embeddingText`); send literal `null` to clear all three fields. Partial
  patches merge against existing values — touching `triggers` does not erase
  `whenToUse`.

**What still doesn't work:**

- Semantic / vector embedding ranking. Stage 2b is keyword-only (BM25); two
  queries that mean the same thing but share no words still rank apart. Stage 3
  adds a pluggable embedding provider (`IEmbeddingProvider`) and hybrid
  scoring (`α·BM25 + (1−α)·cosine`).
- Stage 2b uses an **in-memory** index. It rebuilds on startup from the
  `skills` table and stays current via `skill:created/updated/imported/deleted`
  events on the DomainEventBus. Cold-start latency scales with skill count;
  cluster deployments where every replica indexes independently is fine for
  thousands of skills, not yet for millions.

**Compatibility:** zero breaking changes. Skills without retrieval signals are
still indexed using `${name} ${description ?? ""}` as the embedding source, so
older packages stay searchable. The new `skill_search` tool is additive — your
existing `skill_list` / `skill_view` / `skill_file` / `skill_feedback` /
`skill_pipeline` calls behave identically.

**For operators:**

- The index hydrates in `serve-cmd` startup (`await searchService.init()`).
  If hydration fails, the server still starts and `skill_search` soft-fails
  with `[]` and a warn-level log — no request errors out.
- Field caps are enforced on every write path (importer, admin REST, service
  layer): triggers ≤ 32 entries × 128 chars each, `whenToUse` ≤ 2048 chars,
  `embeddingText` ≤ 8192 chars. Cap violations return 400 with an explicit
  message.

---

### Embedding retrieval PoC — stage 2a (P1-11)

The retrieval-signal fields you added in stage 1 (`triggers`, `when_to_use`,
`embedding_text`) are now **persisted to the database** when you import. No
action required — re-import is **not** necessary; new imports and updates
will start writing the new column automatically.

**What changed under the hood:**

- New column `skills.retrieval_meta` (drizzle migration `0013`) stores the
  three fields as a single JSON envelope. We chose one envelope over three
  typed columns because stage 3 will extend it (`embedding_vector_hash`,
  `embedding_model_version`, etc.) without further schema migrations.
- The importer now writes the column on every create/update, **including the
  rollback path** — if a re-import fails midway, the row no longer ends up
  advertising new retrieval signals while disk holds the old bytes.
- Corrupt or array-shaped JSON in the column safely degrades to `{}` and
  bumps `skill_mcp_skill_row_json_parse_errors_total{column="retrieval_meta"}`
  so operators can spot persistent corruption (mirrors the existing pattern
  for `attributes`). NULL stays NULL — that's how legacy rows that pre-date
  this release stay distinguishable from "explicitly empty".

**What still doesn't work yet:**

- The BM25 keyword index, `skill_search` MCP tool, and `skill_list?query=`
  parameter — all of those land in stage 2b. Today the column is written
  but no query path reads from it. That's by design: stage 2a's job is to
  guarantee the data is there *before* the indexer ships, so that operators
  upgrading mid-stage don't have to backfill.

**Compatibility:** zero breaking changes. The column is nullable and all
existing skills hydrate cleanly with `retrievalMeta: null`. Adding `triggers`
/ `when_to_use` / `embedding_text` to your `SKILL.md` and re-importing now
makes the fields query-ready the moment stage 2b lands.

---

### Embedding retrieval PoC — stage 1 (P1-11)

`SKILL.md` frontmatter now accepts three optional retrieval-signal fields. These
are **forward-compat only** in this release — the `skill_search` MCP tool and
hybrid BM25 + embedding ranking that consume them ship in stages 2 and 3 of
P1-11. Adding them today is a no-op other than improved future-search quality.

```yaml
---
manifest_schema: "1.0"
name: ripgrep-helper
description: Search a directory tree for a regex pattern.
triggers:               # NEW (P1-11)
  - "search a directory"
  - "find regex matches"
  - "grep for pattern"
when_to_use: |          # NEW (P1-11)
  Use when the user wants to find text patterns recursively across files.
  Prefer this over `read_file` when they don't know which file to read.
embedding_text: |       # NEW (P1-11) — optional; auto-derived if omitted
  ripgrep wrapper; recursive directory pattern search; faster than grep.
---
```

**What you should do today:**

- New skills: add `triggers`, `when_to_use`, and (optionally) `embedding_text`.
  These will be indexed automatically once stage 2 ships.
- Existing skills: `lint-cmd` emits an info-level nudge when all three are
  absent — search quality will degrade once `skill_search` lands. No warnings
  or errors; legacy packages keep importing.

**Field caps** (rejected at import with explicit error):

| Field            | Cap                                |
|------------------|------------------------------------|
| `triggers`       | ≤ 32 entries × ≤ 128 chars each    |
| `when_to_use`    | ≤ 2048 chars                       |
| `embedding_text` | ≤ 8192 chars                       |

**Compatibility:** No breaking changes. Packages without the new fields import
exactly as before. Stage 2 (BM25 + `skill_search`) and stage 3 (pluggable
embedding provider + hybrid scoring) will consume these fields without
requiring re-import — just add them to your SKILL.md before stage 2 lands.

---

### Integration test minimum-viable landing (P1-22)

Skill-mcp now ships three in-process integration test files that pin the
guarantees the most recently delivered multi-module features rely on
(P1-13.5 quota, P1-16 webhook outbound, P0-B EventBus async). They run
with the rest of `npm test` — no Docker, no spawn, no testcontainers.

| File | Scenario | Tests |
|---|---|---|
| `tests/integration/quota-enforcement.test.ts` | I-08: real DB → repo → `UsageMeterService` → `QuotaService` → `createQuotaCheck` middleware → 429 envelope + headers | 5 |
| `tests/integration/webhook-retry-loop.test.ts` | I-09: real DB → `WebhookService` + `WebhookDispatcher` with stubbed fetch, 8-attempt retry → `dead_letter`, admin replay loop, HMAC verification | 5 |
| `tests/integration/eventbus-async.test.ts` | I-06: `DomainEventBus({async:true})` listener isolation, rejection handling, non-blocking publish, error metric increments | 7 |

**Why this matters:** these three batches were the first multi-component
features in the project where unit tests on each piece individually
left a gap — nothing exercised the chain end-to-end with real wiring.
The minimum-viable landing closes that gap for the §16.4 review item.

**Operator notes:**

- These tests use an ephemeral SQLite file under `os.tmpdir()` per `beforeEach`
  and tear it down in `afterEach` — no shared state across runs.
- The stubbed `fetchImpl` in I-09 makes the 8-attempt loop run in milliseconds
  instead of the real 24h/600s backoff window.
- Remaining 9 integration / 6 E2E / 4 chaos scenarios from review §16
  are deferred to P1 batch 34. The current set covers the highest-risk
  feature surfaces (billing path, retry queue, event bus).

---

### Webhook outbound (P1-16)

Skill-mcp now ships a complete outbound webhook subsystem. Subscribers register
a URL + a list of event types and receive HMAC-signed POSTs whenever those events
fire. Failed deliveries are retried with exponential backoff and dead-lettered
after 8 attempts (or a 24h budget); operators can replay any dead-letter from
the admin REST API.

**Supported event types** (more will be added in future releases):

| Event type            | Producer                                     |
|-----------------------|----------------------------------------------|
| `skill.published`     | `SkillImporter` after a successful import    |
| `skill.deprecated`    | `SkillService.adminTransitionLifecycle`      |
| `pipeline.completed`  | `PipelineExecutor` (terminal status)         |
| `user.token_rotated`  | `skill-mcp user rotate-token` CLI            |

**HMAC signing**: every request carries `X-Skill-MCP-Signature: t=<unix>,v1=<hmac_sha256_hex>`.
The signed string is `<unix>.<request_body>`. Receivers MUST verify both the
timestamp drift (reject if more than 5 minutes old) and the HMAC — replaying an
old body with a stale `t` is an attack.

**Retry policy**:

| Failure                        | Action                                |
|--------------------------------|---------------------------------------|
| `2xx`                          | `success`, no retry                   |
| `4xx` (any)                    | `dead_letter` immediately, no retry   |
| `5xx` or network error         | retry, `min(2^attempt + jitter, 600)s`|
| Attempt 8 (or 24h budget)      | `dead_letter`                         |

**Six admin REST endpoints (snake_case JSON):**

```bash
GET    /api/admin/webhooks                       # list (secret hidden)
POST   /api/admin/webhooks                       # create — secret returned ONCE in response
GET    /api/admin/webhooks/:id                   # detail (secret hidden)
PUT    /api/admin/webhooks/:id                   # update url/event_types/enabled/description
POST   /api/admin/webhooks/:id/rotate            # rotate secret — new secret returned ONCE
DELETE /api/admin/webhooks/:id                   # remove subscription (cascade: orphans deliveries)
GET    /api/admin/webhooks/:id/deliveries?limit= # audit: last N (default 50, max 500)
POST   /api/admin/webhook-deliveries/:id/replay  # 202 — re-queue a dead-lettered delivery
```

**Example create:**

```bash
curl -X POST https://your-host/api/admin/webhooks \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://hooks.example.com/skill-events",
    "event_types": ["skill.published", "skill.deprecated"],
    "description": "Notify ops on skill lifecycle changes"
  }'
# 201 Created
# {
#   "success": true,
#   "data": {
#     "id": "wh_…",
#     "url": "https://hooks.example.com/skill-events",
#     "secret": "abc123…",   ← capture this NOW; never returned again
#     "event_types": ["skill.published", "skill.deprecated"],
#     "enabled": true,
#     ...
#   }
# }
```

**Operator notes:**

- **HTTPS required in production**: when `NODE_ENV=production`, plain `http://`
  URLs and private/loopback IPs are rejected at create time. Set
  `NODE_ENV=development` for local testing.
- **Replay flow**: a `dead_letter` delivery has `attempt=8` and `next_retry_at=null`.
  Calling the replay endpoint resets `attempt=0`, `status=pending`, and queues
  it on the worker; the original failure metadata stays in the DB for audit.
- **Worker tuning**: `WebhookWorker` polls every 5s when idle, 200ms when busy,
  batch size 32. Same shape as `BackgroundImportWorker` — no new env knobs.
- **No admin UI yet**: management is REST-only for this release. The bundled
  Admin UI ships in P1-20.

---

### Tier limits + per-field overrides (P1-13.5)

Quotas are now enforced per tenant, layered on top of the P1-13 usage events.
Three built-in tiers ship out of the box; you override individual numbers
without losing the tier label.

**Tier defaults** (`DEFAULT_TIER_LIMITS`):

| Tier        | max_users | max_skills | max_storage_bytes | max_api_calls/day | max_pipeline_runs/day |
|-------------|-----------|------------|-------------------|-------------------|-----------------------|
| free        | 3         | 20         | 100 MiB           | 1 000             | 50                    |
| team        | 25        | 200        | 5 GiB             | 50 000            | 1 000                 |
| enterprise  | 1 000     | 10 000     | 100 GiB           | 1 000 000         | 50 000                |

A free-tier row is auto-seeded the first time a tenant is read, so existing
deployments keep working with no manual migration.

**Six new admin endpoints (snake_case JSON):**

```bash
GET    /api/admin/tenants/:tenantId/quota
PUT    /api/admin/tenants/:tenantId/quota          # body: { tier, max_*?, notes? }
GET    /api/admin/tenants/:tenantId/quota/history  # newest first
GET    /api/admin/tenants/:tenantId/overrides      # ?all=true to include expired
POST   /api/admin/tenants/:tenantId/overrides      # body: { field_name, override_value, reason, granted_by, expires_at? }
DELETE /api/admin/quota-overrides/:overrideId      # ?tenantId=… invalidates cache
```

**Gateway response when a quota is exceeded:**

```
HTTP/1.1 429 Too Many Requests
Retry-After: 60
X-Quota-Limit: 1000
X-Quota-Remaining: 0
X-Quota-Source: tier
Content-Type: application/json

{
  "success": false,
  "error": "Quota exceeded",
  "dimension": "api_calls",
  "limit": 1000,
  "used": 1000,
  "retryAfterSec": 60
}
```

When the request is allowed, the same `X-Quota-Limit` / `X-Quota-Remaining` /
`X-Quota-Source` headers are emitted (only when the limit is finite — unlimited
deployments don't pay that cost).

**Operator notes:**

- **Fail-open**: any error inside `QuotaService.check()` (DB outage, malformed
  override row) returns `{ok: true, source: "unknown", limit: Infinity}` and is
  logged at `warn`. Billing is important; serving traffic is more important.
- **5s per-tenant cache** keeps the hot path off SQLite. Admin writes call
  `quotaService.invalidate(tenantId)` so a tier bump or new override is visible
  on the very next request — you don't need to wait out the TTL.
- **Override audit trail**: `reason` is mandatory non-empty text and `granted_by`
  is required. Use these to prove who approved a customer's bumped limit.
- **Daily window**: `api_calls` and `pipeline_runs` use a UTC midnight rolling
  window. `users`, `skills`, and `storage_bytes` are running totals.
- **Middleware order**: rate-limit runs before quota-check. A 429 from rate-limit
  is "slow down"; a 429 from quota-check is "you've hit your daily budget" — the
  `Retry-After` and body distinguish them so dashboards can split the two.

### Usage metering (P1-13)

The server now records per-tenant usage events for four categories:

| Event type        | Quantity semantics            | Triggered on                                  |
|-------------------|-------------------------------|-----------------------------------------------|
| `skill.view`      | always `1`                    | every `skill_view` MCP/CLI/REST call          |
| `pipeline.run`    | number of stages              | every pipeline execution                      |
| `api.call`        | always `1`                    | every HTTP request (skips `/metrics` & 404s)  |
| `storage.write`   | bytes written                 | every successful skill import                 |

Events are stored in `usage_events` (SQLite) and grouped by hour bucket
(`YYYY-MM-DDTHH`, UTC).

**Two new admin endpoints:**

```bash
# Aggregate (group by event_type + hour_bucket, sum quantity)
GET /api/admin/usage/aggregate
    ?tenantId=default
    &fromBucket=2026-05-28T00
    &toBucket=2026-05-28T23
    &eventType=skill.view        # optional, canonical or <domain>.<name>
    &format=json                 # or csv (downloads usage-<tenant>.csv)

# Raw events (latest first)
GET /api/admin/usage/events
    ?tenantId=default
    &limit=200                   # 1..10000, default 1000
```

CSV exports include the header row even when the result is empty, so spreadsheets
won't break.

**Operator notes:**

- Metering is **fire-and-forget**: a database write failure on the hot path is
  logged at `warn` and swallowed. Skill viewing, pipeline execution, and imports
  will never fail because of metering.
- The default tenant is `"default"`; set `tenantId` explicitly via the request
  context for multi-tenant deployments.
- To prune old events, call `usageEventRepo.deleteOlderThan(cutoffMs)` from a
  cron / scheduled task. (A built-in retention job will be added in a later
  batch.)

### Manifest schema versioning contract (P1-21)

`SKILL.md` frontmatter now accepts an optional `manifest_schema` field that
declares which contract version your package targets. The current schema is
`"1.0"`.

```yaml
---
manifest_schema: "1.0"   # <-- NEW (recommended; auto-coerced if missing)
name: my-skill
version: 0.0.1
description: …
entry: SKILL.md
---
```

**What this means for you:**

| Your package's `manifest_schema` | This server (1.x) | A future 2.x server |
|----------------------------------|-------------------|----------------------|
| missing / `0.x`                  | ✅ accepted, coerced to `1.0` + deprecation warning | ⚠️ may be rejected |
| `1.0` (any 1.y)                  | ✅ accepted       | ✅ accepted (back-compat window: 2 minors) |
| `2.0+`                           | ❌ "server too old, please upgrade" | ✅ accepted |

**What you should do:** Add `manifest_schema: "1.0"` to your existing
SKILL.md files. The server still accepts old packages, but you'll see a
deprecation warning every time you import them, and a future 2.x server
may stop accepting them.

**Tools to migrate at scale:**

```bash
# Dry-run a tree of packages (default)
skill-mcp manifest:migrate ./my-skills

# Rewrite SKILL.md files in place
skill-mcp manifest:migrate ./my-skills --apply

# Or emit a unified diff suitable for code review / `git apply`
skill-mcp manifest:migrate ./my-skills --patch | git apply
```

The migrator preserves your existing line endings (CRLF/LF) and
field ordering — `manifest_schema` is inserted as the first frontmatter
key without re-serialising the YAML, so diffs stay clean.

**Compatibility:** No breaking changes for existing users. Packages without
`manifest_schema` continue to import successfully; only the new warning
appears in import logs.

**See also:**
- README.md "Manifest Schema Versioning"
- `docs/ARCHITECTURE.md` §11.6 "Manifest 版本契约"
- `docs/REVIEWS/2026-05-27-commercialization-review-claude.md` §14.5

---

## 1.0.0 — 2026-05-06

Initial release. See `CHANGELOG.md` for the full list.
